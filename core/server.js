#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

function defaultEcosystemRoot() {
  const parent = path.join(__dirname, '..');
  try {
    if (fs.existsSync(path.join(parent, 'agents')) &&
        fs.existsSync(path.join(parent, 'skills'))) {
      return parent;
    }
  } catch { }
  return '';
}

const ECOSYSTEM_ROOT = process.env.ECOSYSTEM_ROOT || defaultEcosystemRoot();
const redis = require('redis');
const http = require('http');
const { WebSocketServer } = require('ws');

const { ownPort, getPort } = require('./middleware/ports');
const { signHeaders, assertUsable: assertSigningKeyUsable } = require('./middleware/sign-outbound');
const {
  NOTE_EMBEDDING_OUTBOX_KEY,
  persistNoteWithOutbox,
  createNoteEmbeddingOutbox,
} = require('./note-embedding-outbox');
const {
  retentionSeconds,
  noteRetentionSeconds,
  taskRetentionSeconds,
} = require('./retention');
const { createChatArchive } = require('./chat-archive');
const {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  InboxValidationError,
  fingerprintEnvelope,
  parseInboxEnvelope,
  storeAttachment,
  buildInboxNote,
} = require('./inbox-document');
assertSigningKeyUsable();
const { NoteTypeValues, TaskStatusValues } = require('./generated/schemas');
const { loadServices } = require('./services-registry');

const SERVER_VERSION = require('./package.json').version;

const app = express();
const PORT = ownPort('consciousness-server', 3032);

const PUBLIC_URL = process.env.PUBLIC_URL || '';

const FSM_STATES = ['OFFLINE', 'STARTING', 'IDLE', 'BUSY', 'BLOCKED', 'ERROR'];
const FSM_LEGACY_MAP = { FREE: 'IDLE' };
const HEARTBEAT_OFFLINE_THRESHOLD_SEC = 120;

function normalizeFsmState(status) {
  if (status === null || status === undefined) return null;
  const upper = String(status).toUpperCase();
  return FSM_LEGACY_MAP[upper] || upper;
}

function isValidFsmState(status) {
  return FSM_STATES.includes(status);
}


const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),

    reconnectStrategy: (attempt) => Math.min(50 * 2 ** Math.min(attempt, 7), 5000)
  }
});

let redisReady = false;
let dataLoading = true;
let redisDownSince = Date.now();
let redisEverConnected = false;

function setRedisReady(ready, why) {
  if (ready === redisReady) return;
  redisReady = ready;

  if (!ready) {
    redisDownSince = Date.now();
    console.error(`❌ Redis niedostępny (${why}) — rdzeń pracuje na pamięci, zapisy nie przetrwają restartu`);
    announceRedis(`Redis niedostępny (${why}). Notatki, zadania i czat nie są utrwalane. Rdzeń zgłasza status degraded.`);
    return;
  }

  const downFor = redisDownSince ? Math.round((Date.now() - redisDownSince) / 1000) : 0;
  const firstConnect = !redisEverConnected;
  redisEverConnected = true;
  redisDownSince = null;

  if (firstConnect) {
    console.log('✅ Redis ready');
    return;
  }
  console.log(`✅ Redis wrócił po ${downFor}s`);
  announceRedis(`Redis wrócił po ${downFor}s. Utrwalanie działa.`);
  hydrateFromRedis().catch((err) => console.error('Redis: wczytywanie po powrocie nie powiodło się:', err.message));
}

function announceRedis(text) {
  try {
    const msg = {
      id: uuidv4(),
      from: 'cs-core',
      content: `@all ${text}`,
      mentions: ['ALL'],
      timestamp: getCurrentTimestamp()
    };
    chatMessages.push(msg);
    emit('chat', 'chat_message', msg);
  } catch (err) {
    console.error('Redis: nie udało się ogłosić stanu na czacie:', err.message);
  }
}

async function hydrateFromRedis() {
  console.log('🔄 Loading data from Redis...');
  await loadFromRedis();
  await loadChatFromRedis();
  await chatArchive.start(() => [...chatMessages]).catch(error => {
    console.error(`[chat-archive] reconciliation failed: ${error.message}`);
  });
  await loadNotesFromRedis();
  await loadConversationsFromRedis();
  await loadTrainingDataFromRedis();
  await loadSummariesFromRedis();
  dataLoading = false;
}

redisClient.on('error', (err) => setRedisReady(false, err.message));
redisClient.on('ready', () => setRedisReady(true, 'ready'));
redisClient.on('end', () => setRedisReady(false, 'połączenie zamknięte'));
redisClient.on('connect', () => console.log('✅ Redis connected'));
redisClient.on('reconnecting', () => console.warn('Redis: ponawiam połączenie…'));

(async () => {
  try {
    await redisClient.connect();
    await hydrateFromRedis();
  } catch (err) {
    console.error(`❌ Redis niedostępny przy starcie (${err.message}) — rdzeń wstaje w stanie degraded i ponawia w tle`);
  }
})();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});



const RATE_LIMITS = {
  max_requests_per_minute: 60,
  max_tasks_per_hour: 100,
  max_chat_messages_per_minute: 30,
  max_consecutive_errors: 5,
  task_timeout_minutes: 30
};

const rateLimitCounters = new Map();

function getRateLimitCounter(agentName) {
  if (!rateLimitCounters.has(agentName)) {
    rateLimitCounters.set(agentName, {
      requests: [],
      tasks: [],
      chatMessages: [],
      errors: 0,
      paused: false,
      pausedAt: null,
      pauseReason: null
    });
  }
  return rateLimitCounters.get(agentName);
}

function cleanOldTimestamps(timestamps, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  return timestamps.filter(ts => ts > cutoff);
}

function checkRateLimit(agentName, limitType) {
  if (!agentName || agentName === 'unknown') return null;
  
  const counter = getRateLimitCounter(agentName);
  const now = Date.now();
  
  if (counter.paused) {
    const pausedSecondsAgo = Math.floor((now - counter.pausedAt) / 1000);
    if (pausedSecondsAgo > 300) {
      counter.paused = false;
      counter.pausedAt = null;
      counter.pauseReason = null;
      counter.errors = 0;
    } else {
      return {
        error: 'rate_limit_exceeded',
        limit_type: 'agent_paused',
        reason: counter.pauseReason,
        retry_after_seconds: 300 - pausedSecondsAgo
      };
    }
  }
  
  counter.requests = cleanOldTimestamps(counter.requests, 60000);
  counter.tasks = cleanOldTimestamps(counter.tasks, 3600000);
  counter.chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
  
  let limit, current, timeWindowSec;
  
  switch(limitType) {
    case 'requests':
      limit = RATE_LIMITS.max_requests_per_minute;
      current = counter.requests.length;
      timeWindowSec = 60;
      break;
    case 'tasks':
      limit = RATE_LIMITS.max_tasks_per_hour;
      current = counter.tasks.length;
      timeWindowSec = 3600;
      break;
    case 'chatMessages':
      limit = RATE_LIMITS.max_chat_messages_per_minute;
      current = counter.chatMessages.length;
      timeWindowSec = 60;
      break;
    default:
      return null;
  }
  
  if (current >= limit) {
    const oldest = counter[limitType === 'chatMessages' ? 'chatMessages' : limitType][0];
    const expiresIn = oldest ? Math.ceil((oldest + (timeWindowSec * 1000) - now) / 1000) : timeWindowSec;
    
    return {
      error: 'rate_limit_exceeded',
      limit_type: limitType === 'requests' ? 'max_requests_per_minute' :
                  limitType === 'tasks' ? 'max_tasks_per_hour' :
                  'max_chat_messages_per_minute',
      current: current,
      limit: limit,
      retry_after_seconds: Math.max(1, expiresIn)
    };
  }
  
  return null;
}

function recordRateLimitAction(agentName, actionType) {
  if (!agentName || agentName === 'unknown') return;
  
  const counter = getRateLimitCounter(agentName);
  const now = Date.now();
  
  switch(actionType) {
    case 'requests':
      counter.requests.push(now);
      break;
    case 'tasks':
      counter.tasks.push(now);
      break;
    case 'chatMessages':
      counter.chatMessages.push(now);
      break;
  }
  
  counter.errors = 0;
}

function recordRateLimitError(agentName) {
  if (!agentName || agentName === 'unknown') return;
  
  const counter = getRateLimitCounter(agentName);
  counter.errors++;
  
  if (counter.errors >= RATE_LIMITS.max_consecutive_errors) {
    counter.paused = true;
    counter.pausedAt = Date.now();
    counter.pauseReason = 'max_consecutive_errors';
    console.log(`[RATE-LIMIT] Agent ${agentName} paused: too many consecutive errors (${counter.errors})`);
  }
}

function pauseAgentRateLimit(agentName, reason) {
  const counter = getRateLimitCounter(agentName);
  counter.paused = true;
  counter.pausedAt = Date.now();
  counter.pauseReason = reason;
  console.log(`[RATE-LIMIT] Agent ${agentName} paused: ${reason}`);
}

function resetRateLimitCounters(agentName) {
  rateLimitCounters.set(agentName, {
    requests: [],
    tasks: [],
    chatMessages: [],
    errors: 0,
    paused: false,
    pausedAt: null,
    pauseReason: null
  });
}

app.use((req, res, next) => {
  const agentName = req._verifiedAgent ||
                    req.body?.agent ||
                    req.body?.from ||
                    req.body?.created_by ||
                    req.params?.agent ||
                    req.params?.name ||
                    req.query?.agent ||
                    req.headers['x-agent-name'] ||
                    'unknown';
  
  req.agentName = agentName;
  
  if (req.path === '/health' || req.path.startsWith('/api/rate-limits')) {
    return next();
  }
  
  const limitError = checkRateLimit(agentName, 'requests');
  if (limitError) {
    console.log(`[RATE-LIMIT] Agent ${agentName} exceeded request limit`);
    return res.status(429).json(limitError);
  }
  
  recordRateLimitAction(agentName, 'requests');
  
  next();
});


app.get('/api/rate-limits', (req, res) => {
  res.json({
    limits: RATE_LIMITS,
    description: {
      max_requests_per_minute: 'Maximum API requests per agent per minute',
      max_tasks_per_hour: 'Maximum tasks created per agent per hour',
      max_chat_messages_per_minute: 'Maximum chat messages per agent per minute',
      max_consecutive_errors: 'Auto-pause agent after this many consecutive errors',
      task_timeout_minutes: 'Maximum task duration before timeout warning'
    }
  });
});

app.get('/api/rate-limits/status/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const counter = getRateLimitCounter(agentName);
  
  const requests = cleanOldTimestamps(counter.requests, 60000);
  const tasks = cleanOldTimestamps(counter.tasks, 3600000);
  const chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
  
  res.json({
    agent: agentName,
    status: counter.paused ? 'paused' : 'active',
    pause_reason: counter.pauseReason,
    paused_at: counter.pausedAt ? new Date(counter.pausedAt).toISOString() : null,
    usage: {
      requests_per_minute: {
        current: requests.length,
        limit: RATE_LIMITS.max_requests_per_minute,
        remaining: Math.max(0, RATE_LIMITS.max_requests_per_minute - requests.length)
      },
      tasks_per_hour: {
        current: tasks.length,
        limit: RATE_LIMITS.max_tasks_per_hour,
        remaining: Math.max(0, RATE_LIMITS.max_tasks_per_hour - tasks.length)
      },
      chat_messages_per_minute: {
        current: chatMessages.length,
        limit: RATE_LIMITS.max_chat_messages_per_minute,
        remaining: Math.max(0, RATE_LIMITS.max_chat_messages_per_minute - chatMessages.length)
      }
    },
    consecutive_errors: counter.errors,
    max_consecutive_errors: RATE_LIMITS.max_consecutive_errors,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/reset/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  
  resetRateLimitCounters(agentName);
  
  console.log(`[RATE-LIMIT] Counters reset for agent ${agentName}`);
  
  res.json({
    success: true,
    agent: agentName,
    message: 'Rate limit counters reset',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rate-limits/all', (req, res) => {
  const allStatus = [];
  
  rateLimitCounters.forEach((counter, agentName) => {
    const requests = cleanOldTimestamps(counter.requests, 60000);
    const tasks = cleanOldTimestamps(counter.tasks, 3600000);
    const chatMessages = cleanOldTimestamps(counter.chatMessages, 60000);
    
    allStatus.push({
      agent: agentName,
      status: counter.paused ? 'paused' : 'active',
      pause_reason: counter.pauseReason,
      requests_per_minute: requests.length,
      tasks_per_hour: tasks.length,
      chat_messages_per_minute: chatMessages.length,
      consecutive_errors: counter.errors
    });
  });
  
  res.json({
    total_agents: allStatus.length,
    agents: allStatus,
    limits: RATE_LIMITS,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/pause/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const { reason } = req.body;
  
  pauseAgentRateLimit(agentName, reason || 'manual_pause');
  
  res.json({
    success: true,
    agent: agentName,
    status: 'paused',
    reason: reason || 'manual_pause',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/rate-limits/unpause/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const counter = getRateLimitCounter(agentName);
  
  counter.paused = false;
  counter.pausedAt = null;
  counter.pauseReason = null;
  counter.errors = 0;
  
  console.log(`[RATE-LIMIT] Agent ${agentName} unpaused`);
  
  res.json({
    success: true,
    agent: agentName,
    status: 'active',
    timestamp: new Date().toISOString()
  });
});



let tasks = [];
let logs = [];
let agents = [];
let brainstorms = [];
let chatMessages = [];

const chatArchive = createChatArchive({
  archiveDir: process.env.CHAT_ARCHIVE_DIR || '',
  intervalMs: parseInt(process.env.CHAT_ARCHIVE_CHECK_MS || '3600000', 10),
});

let conversations = [];
let trainingData = [];
let summaries = [];


function getCurrentTimestamp() {
  return new Date().toISOString();
}

function findTaskById(taskId) {
  return tasks.find(t => t.id === taskId);
}

function findAgentByName(name) {
  return agents.find(a => a.name === name);
}

function findBrainstormById(id) {
  return brainstorms.find(b => b.id === id);
}


// Single write path so a term is never chosen at a call site.
async function persistWithRetention(key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  if (ttlSeconds === null) {
    await redisClient.set(key, payload);
    return;
  }
  await redisClient.setEx(key, ttlSeconds, payload);
}

async function saveLog(log) {
  await persistWithRetention(`log:${log.id}`, log, retentionSeconds('log'));
}

async function saveTask(task) {
  await persistWithRetention(`task:${task.id}`, task, taskRetentionSeconds(task));
}

async function saveAgent(agent) {
  await persistWithRetention(`agent:${agent.name}`, agent, retentionSeconds('agent'));
}

async function saveBrainstorm(brainstorm) {
  await persistWithRetention(`brainstorm:${brainstorm.id}`, brainstorm, retentionSeconds('brainstorm'));
}

async function deleteBrainstorm(id) {
  await redisClient.del(`brainstorm:${id}`);
}


async function saveConversation(conv) {
  await persistWithRetention(`conversation:${conv.id}`, conv, retentionSeconds('conversation'));
}

async function saveTrainingData(data) {
  await persistWithRetention(`training:${data.id}`, data, retentionSeconds('training'));
}

async function saveSummary(summary) {
  await persistWithRetention(`summary:${summary.id}`, summary, retentionSeconds('summary'));
}

async function loadConversationsFromRedis() {
  try {
    const keys = await redisClient.keys('conversation:*');
    conversations = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) conversations.push(JSON.parse(data));
    }
    conversations.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`💬 Loaded ${conversations.length} conversations from Redis`);
  } catch (error) {
    console.error('Failed to load conversations from Redis:', error);
  }
}

async function loadTrainingDataFromRedis() {
  try {
    const keys = await redisClient.keys('training:*');
    trainingData = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) trainingData.push(JSON.parse(data));
    }
    trainingData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`🎓 Loaded ${trainingData.length} training examples from Redis`);
  } catch (error) {
    console.error('Failed to load training data from Redis:', error);
  }
}

async function loadSummariesFromRedis() {
  try {
    const keys = await redisClient.keys('summary:*');
    summaries = [];
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) summaries.push(JSON.parse(data));
    }
    summaries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`📝 Loaded ${summaries.length} summaries from Redis`);
  } catch (error) {
    console.error('Failed to load summaries from Redis:', error);
  }
}

async function loadFromRedis() {
  try {
    const taskKeys = await redisClient.keys('task:*');
    tasks = [];
    for (const key of taskKeys) {
      const data = await redisClient.get(key);
      if (data) tasks.push(JSON.parse(data));
    }

    const logKeys = await redisClient.keys('log:*');
    logs = [];
    for (const key of logKeys) {
      const data = await redisClient.get(key);
      if (data) logs.push(JSON.parse(data));
    }

    const agentKeys = await redisClient.keys('agent:*');
    agents = [];
    for (const key of agentKeys) {
      const data = await redisClient.get(key);
      if (data) agents.push(JSON.parse(data));
    }

    const brainstormKeys = await redisClient.keys('brainstorm:*');
    brainstorms = [];
    for (const key of brainstormKeys) {
      const data = await redisClient.get(key);
      if (data) brainstorms.push(JSON.parse(data));
    }

    console.log(`📦 Loaded from Redis: ${tasks.length} tasks, ${logs.length} logs, ${agents.length} agents, ${brainstorms.length} brainstorms`);
  } catch (error) {
    console.error('Failed to load from Redis:', error);
  }
}


const SEMANTIC_SEARCH_ALLOWED_HOSTS = (process.env.SEMANTIC_SEARCH_ALLOWED_HOSTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isValidSemanticSearchUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (SEMANTIC_SEARCH_ALLOWED_HOSTS.length > 0) {
    return SEMANTIC_SEARCH_ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
  }
  return true;
}

const HEALTH_SEMANTIC_TIMEOUT_MS = parseInt(
  process.env.HEALTH_SEMANTIC_TIMEOUT_MS || '3000',
  10
);
const HEALTH_SEMANTIC_INTERVAL_MS = parseInt(
  process.env.HEALTH_SEMANTIC_INTERVAL_MS || '15000',
  10
);

let semanticProbe = { status: 'unknown', embeddings: null };

async function probeSemanticSearch() {
  const raw = process.env.SEMANTIC_SEARCH_URL || 'http://localhost:3037';
  if (!isValidSemanticSearchUrl(raw)) {
    if (semanticProbe.status !== 'misconfigured') {
      console.warn(
        `[health] SEMANTIC_SEARCH_URL is not a valid http(s) URL: ${JSON.stringify(raw)} — skipping probe`
      );
    }
    semanticProbe = { status: 'misconfigured', embeddings: null };
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_SEMANTIC_TIMEOUT_MS);
  try {
    const r = await fetch(`${raw}/health`, { signal: ctrl.signal });
    if (r.ok) {
      const j = await r.json();
      semanticProbe = { status: 'ok', embeddings: j?.collections?.conversations ?? null };
    } else {
      semanticProbe = { status: `http_${r.status}`, embeddings: null };
    }
  } catch (err) {
    const status = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    if (semanticProbe.status !== status) {
      console.warn(`[health] semantic-search probe ${status}: ${err.message || err.name}`);
    }
    semanticProbe = { status, embeddings: null };
  } finally {
    clearTimeout(timer);
  }
}

probeSemanticSearch();
const semanticProbeTimer = setInterval(probeSemanticSearch, HEALTH_SEMANTIC_INTERVAL_MS);
if (typeof semanticProbeTimer.unref === 'function') semanticProbeTimer.unref();

app.get('/health', async (req, res) => {
  const uptime = process.uptime();

  const conversationEmbeddings = semanticProbe.embeddings;
  const semanticHealth = semanticProbe.status;

  const redisHealth = redisReady ? 'ok' : 'unreachable';
  const countsComplete = !dataLoading;
  const chatArchiveHealth = chatArchive.getStatus();
  const status = dataLoading
    ? 'loading'
    : (redisReady && !chatArchiveHealth.overdue && chatArchiveHealth.state !== 'error'
        ? 'ok'
        : 'degraded');

  const redisDownSeconds = redisDownSince ? Math.round((Date.now() - redisDownSince) / 1000) : 0;

  res.json({
    status,
    uptime: Math.floor(uptime),
    version: SERVER_VERSION,
    counts_complete: countsComplete,
    memory: {
      tasks: tasks.length,
      logs: logs.length,
      agents: agents.length,
      brainstorms: brainstorms.length,
      notes: notes.length,
      chat_messages: chatMessages.length,
      conversation_embeddings: conversationEmbeddings,
      training_data: trainingData.length
    },
    semantic_search: semanticHealth,
    redis: redisHealth,
    redis_down_seconds: redisDownSeconds,
    chat_archive: chatArchiveHealth,
    timestamp: getCurrentTimestamp()
  });
});

function emitTaskEvent(type, data) {
  emit('tasks', type, data);
}

function createTaskHandler(req, res) {
  const { project, assigned_to, created_by, title, description, priority, metadata } = req.body;

  const taskRateLimitError = checkRateLimit(created_by || req.agentName, 'tasks');
  if (taskRateLimitError) {
    console.log(`[RATE-LIMIT] Agent ${created_by || req.agentName} exceeded task creation limit`);
    return res.status(429).json(taskRateLimitError);
  }

  if (!project || !title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['project', 'title']
    });
  }

  const task = {
    id: uuidv4(),
    project: project,
    assigned_to: assigned_to || null,
    created_by: created_by || 'coord',
    title: title,
    description: description || '',
    priority: priority || 'NORMAL',
    metadata: metadata || null,
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null
  };

  tasks.push(task);
  saveTask(task);
  recordRateLimitAction(task.created_by || req.agentName, 'tasks');

  emitTaskEvent(task.assigned_to ? 'task_created' : 'task_available', task);

  const log = {
    id: logs.length + 1,
    project: project,
    agent: created_by || 'coord',
    level: 'INFO',
    message: `Task created: ${title}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log);

  res.status(201).json(task);
}

app.post('/api/tasks', createTaskHandler);
app.post('/api/tasks/create', createTaskHandler);

app.get('/api/tasks/pending/:agent', (req, res) => {
  const agentName = req.params.agent;

  const pendingTasks = tasks.filter(t =>
    t.assigned_to === agentName && t.status === 'PENDING'
  );

  const priorityOrder = { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  pendingTasks.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  res.json(pendingTasks);
});

app.get('/api/tasks/available', (req, res) => {
  const available = tasks.filter(t =>
    t.assigned_to === null && t.status === 'PENDING'
  );
  const priorityOrder = { URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
  available.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  res.json(available);
});

app.post('/api/tasks/:id/claim', (req, res) => {
  const taskId = req.params.id;
  const { agent } = req.body || {};

  if (!agent) {
    return res.status(400).json({ error: 'Missing required field: agent' });
  }

  const task = tasks.find(t => t.id === taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (task.assigned_to !== null) {
    return res.status(409).json({
      error: 'Task already claimed',
      assigned_to: task.assigned_to,
      claimed_at: task.claimed_at
    });
  }
  if (task.status !== 'PENDING') {
    return res.status(409).json({
      error: 'Task is not in PENDING status',
      status: task.status
    });
  }

  task.assigned_to = agent;
  task.claimed_at = getCurrentTimestamp();
  saveTask(task);

  emitTaskEvent('task_claimed', task);

  res.json({
    task_id: task.id,
    agent,
    claimed_at: task.claimed_at
  });
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const taskId = req.params.id;
  const { status, result } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Missing required field: status' });
  }

  const task = findTaskById(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (!TaskStatusValues.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status',
      valid_statuses: TaskStatusValues
    });
  }

  const previousStatus = task.status;
  task.status = status;

  if (status === 'IN_PROGRESS' && !task.started_at) {
    task.claimed_at = task.claimed_at || getCurrentTimestamp();
    task.started_at = getCurrentTimestamp();
  }

  if (status === 'DONE' || status === 'FAILED') {
    task.completed_at = getCurrentTimestamp();
    if (result) {
      task.result = result;
    }
  }

  saveTask(task);

  emitTaskEvent('task_updated', {
    task_id: task.id,
    status,
    previous_status: previousStatus,
    task
  });

  const log = {
    id: logs.length + 1,
    project: task.project,
    agent: task.assigned_to,
    level: status === 'FAILED' ? 'ERROR' : 'INFO',
    message: `Task status: ${previousStatus} → ${status}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log);

  res.json({
    success: true,
    task_id: task.id,
    status: task.status,
    previous_status: previousStatus
  });
});


app.post('/api/agents/register', (req, res) => {
  const { name, location, role, capabilities, status: rawStatus } = req.body;

  if (!name || !location || !role) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['name', 'location', 'role']
    });
  }

  let initialStatus = 'IDLE';
  if (rawStatus !== undefined) {
    const normalized = normalizeFsmState(rawStatus);
    if (!isValidFsmState(normalized)) {
      return res.status(400).json({
        error: 'Invalid FSM state',
        valid_states: FSM_STATES,
        received: rawStatus,
        hint: "Legacy 'FREE' accepted (maps to IDLE)"
      });
    }
    initialStatus = normalized;
  }

  const existingAgent = findAgentByName(name);

  if (existingAgent) {
    existingAgent.location = location;
    existingAgent.role = role;
    existingAgent.capabilities = capabilities || existingAgent.capabilities;
    existingAgent.updated_at = getCurrentTimestamp();
    existingAgent.status = initialStatus;
    saveAgent(existingAgent);

    return res.json({
      message: 'Agent updated',
      agent: existingAgent
    });
  }

  const agent = {
    name: name,
    location: location,
    role: role,
    capabilities: capabilities || [],
    status: initialStatus,
    registered_at: getCurrentTimestamp(),
    updated_at: getCurrentTimestamp(),
    last_heartbeat: null
  };

  agents.push(agent);
  saveAgent(agent);

  const log = {
    id: logs.length + 1,
    project: 'ecosystem',
    agent: name,
    level: 'INFO',
    message: `Agent registered: ${name} (${role})`,
    task_id: null,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log);

  res.status(201).json({
    message: 'Agent registered',
    agent: agent
  });
});

app.post('/api/agents/:name/heartbeat', (req, res) => {
  const agentName = req.params.name;
  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({
      error: 'Agent not found',
      hint: 'Register agent first using POST /api/agents/register'
    });
  }

  const { status: rawStatus, task_id, blocked_on } = req.body || {};
  const previousStatus = agent.status;

  if (rawStatus !== undefined) {
    const normalized = normalizeFsmState(rawStatus);
    if (!isValidFsmState(normalized)) {
      return res.status(400).json({
        error: 'Invalid FSM state',
        valid_states: FSM_STATES,
        received: rawStatus,
        hint: "Legacy 'FREE' accepted (maps to IDLE)"
      });
    }
    agent.status = normalized;
  }
  if (task_id !== undefined) agent.current_task = task_id;
  if (blocked_on !== undefined) agent.blocked_on = blocked_on;

  agent.last_heartbeat = getCurrentTimestamp();
  agent.updated_at = agent.last_heartbeat;
  saveAgent(agent);

  if (rawStatus !== undefined && previousStatus !== agent.status) {
    emit('agents', 'agent_status_changed', {
      agent: agentName,
      status: agent.status,
      previous_status: previousStatus,
      task_id: agent.current_task || null,
      blocked_on: agent.blocked_on || null,
      timestamp: agent.last_heartbeat
    });
  }

  res.json({
    success: true,
    agent: agentName,
    status: agent.status,
    previous_status: previousStatus,
    heartbeat: agent.last_heartbeat,
    task_id: agent.current_task || null,
    blocked_on: agent.blocked_on || null
  });
});

app.patch('/api/agents/:name/status', (req, res) => {
  const agentName = req.params.name;
  const { status: rawStatus, task_id, blocked_on } = req.body || {};

  if (!rawStatus) {
    return res.status(400).json({ error: 'Missing required field: status' });
  }

  const normalized = normalizeFsmState(rawStatus);
  if (!isValidFsmState(normalized)) {
    return res.status(400).json({
      error: 'Invalid FSM state',
      valid_states: FSM_STATES,
      received: rawStatus,
      hint: "Legacy 'FREE' accepted (maps to IDLE)"
    });
  }

  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({
      error: 'Agent not found',
      hint: 'Register agent first using POST /api/agents/register'
    });
  }

  const previousStatus = agent.status;
  agent.status = normalized;
  if (task_id !== undefined) agent.current_task = task_id;
  if (blocked_on !== undefined) agent.blocked_on = blocked_on;
  agent.updated_at = getCurrentTimestamp();
  saveAgent(agent);

  emit('agents', 'agent_status_changed', {
    agent: agentName,
    status: agent.status,
    previous_status: previousStatus,
    task_id: agent.current_task || null,
    blocked_on: agent.blocked_on || null,
    timestamp: agent.last_heartbeat
  });

  res.json({
    success: true,
    agent: agentName,
    status: agent.status,
    previous_status: previousStatus,
    task_id: agent.current_task || null,
    blocked_on: agent.blocked_on || null
  });
});

app.get('/api/agents', (req, res) => {
  const now = new Date();

  agents.forEach(agent => {
    const lastHeartbeat = new Date(agent.last_heartbeat);
    const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;

    if (secondsSinceHeartbeat > HEARTBEAT_OFFLINE_THRESHOLD_SEC && agent.status !== 'OFFLINE') {
      agent.status = 'OFFLINE';
    }
  });

  res.json({
    total: agents.length,
    agents: agents
  });
});

app.get('/api/agents/all', (req, res) => {
  const now = new Date();

  const agentsWithStatus = agents.map(agent => {
    const lastHeartbeat = new Date(agent.last_heartbeat);
    const secondsSinceHeartbeat = (now - lastHeartbeat) / 1000;

    let computedStatus = agent.status;
    if (secondsSinceHeartbeat > HEARTBEAT_OFFLINE_THRESHOLD_SEC && agent.status !== 'OFFLINE') {
      computedStatus = 'OFFLINE';
    }

    return {
      ...agent,
      computed_status: computedStatus,
      last_seen: secondsSinceHeartbeat < 60 ? 'just now' :
                 secondsSinceHeartbeat < 3600 ? `${Math.floor(secondsSinceHeartbeat / 60)} min ago` :
                 `${Math.floor(secondsSinceHeartbeat / 3600)} hours ago`,
      uptime_seconds: secondsSinceHeartbeat
    };
  });

  res.json({
    total: agentsWithStatus.length,
    online: agentsWithStatus.filter(a => a.computed_status !== 'OFFLINE').length,
    offline: agentsWithStatus.filter(a => a.computed_status === 'OFFLINE').length,
    agents: agentsWithStatus,
    timestamp: now.toISOString()
  });
});

app.get('/api/agents/:name/history', (req, res) => {
  const agentName = req.params.name;
  const limit = parseInt(req.query.limit) || 100;

  const activities = [];

  tasks.forEach(task => {
    if (task.assigned_to === agentName || task.created_by === agentName) {
      activities.push({
        type: 'task',
        timestamp: task.completed_at || task.started_at || task.created_at,
        action: task.status === 'DONE' ? 'completed_task' : 'started_task',
        details: {
          task_id: task.id,
          title: task.title,
          status: task.status
        }
      });
    }
  });

  chatMessages.forEach(msg => {
    if (msg.from === agentName) {
      activities.push({
        type: 'chat',
        timestamp: msg.timestamp,
        action: 'sent_message',
        details: {
          message_id: msg.id,
          mentions: msg.mentions || [],
          preview: msg.content.substring(0, 100)
        }
      });
    }
  });

  logs.forEach(log => {
    if (log.agent === agentName) {
      activities.push({
        type: 'log',
        timestamp: log.timestamp,
        action: 'logged',
        details: {
          level: log.level,
          message: log.message
        }
      });
    }
  });

  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const limited = activities.slice(0, limit);

  res.json({
    agent: agentName,
    total_activities: activities.length,
    showing: limited.length,
    activities: limited
  });
});

app.get('/api/agents/:name', (req, res) => {
  const agent = findAgentByName(req.params.name);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  res.json(agent);
});

app.get('/api/agents/:name/context', (req, res) => {
  const agent = findAgentByName(req.params.name);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const tokensUsed = agent.context?.tokens_used || 0;
  const tokensLimit = agent.context?.tokens_limit || 200000;
  const usagePercent = Math.round((tokensUsed / tokensLimit) * 100);

  let status = 'healthy';
  if (usagePercent >= 95) status = 'critical';
  else if (usagePercent >= 85) status = 'warning';
  else if (usagePercent >= 70) status = 'caution';

  res.json({
    agent: req.params.name,
    tokens_used: tokensUsed,
    tokens_limit: tokensLimit,
    usage_percent: usagePercent,
    status: status,
    last_updated: agent.last_heartbeat,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/agents/:name/restart', async (req, res) => {
  const agentName = req.params.name;
  const agent = findAgentByName(agentName);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const { reason } = req.body;

  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const sessionName = agentName;
    if (!/^[a-zA-Z0-9._-]+$/.test(sessionName)) {
      return res.status(400).json({
        error: 'Invalid agent name for tmux control',
        agent: agentName,
      });
    }

    try {
      await execFileAsync('tmux', ['has-session', '-t', sessionName]);
    } catch (err) {
      return res.status(404).json({
        error: 'Tmux session not found',
        agent: agentName,
        session: sessionName
      });
    }

    await execFileAsync('tmux', ['send-keys', '-t', sessionName, 'C-c']);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await execFileAsync('tmux', ['send-keys', '-t', sessionName, 'claude', 'Enter']);

    agent.status = 'RESTARTING';
    agent.last_restart = new Date().toISOString();
    agent.restart_reason = reason || 'Manual restart';

    logs.push({
      timestamp: new Date().toISOString(),
      agent: agentName,
      level: 'INFO',
      message: `Agent restarted via API. Reason: ${reason || 'Manual restart'}`,
      project: 'ecosystem'
    });

    res.json({
      success: true,
      agent: agentName,
      message: 'Agent restart initiated',
      session: sessionName,
      reason: reason || 'Manual restart',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to restart agent',
      message: error.message,
      agent: agentName
    });
  }
});


app.get('/api/system/resources/remote', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    let gpuData = null;
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total --format=csv,noheader,nounits');
      const gpuLines = stdout.trim().split('\n');
      gpuData = gpuLines.map(line => {
        const [index, name, temp, gpu_util, mem_util, mem_used, mem_total] = line.split(', ');
        return {
          index: parseInt(index),
          name: name.trim(),
          temperature: parseInt(temp),
          gpu_utilization: parseInt(gpu_util),
          memory_utilization: parseInt(mem_util),
          memory_used_mb: parseInt(mem_used),
          memory_total_mb: parseInt(mem_total)
        };
      });
    } catch (err) {
      console.error('nvidia-smi error:', err.message);
    }

    const { stdout: memInfo } = await execAsync('free -m');
    const memLines = memInfo.split('\n')[1].split(/\s+/);
    const ramTotal = parseInt(memLines[1]);
    const ramUsed = parseInt(memLines[2]);

    const { stdout: cpuInfo } = await execAsync('top -bn1 | grep "Cpu(s)"');
    const cpuMatch = cpuInfo.match(/(\d+\.\d+)\s+us/);
    const cpuUsage = cpuMatch ? parseFloat(cpuMatch[1]) : 0;

    const { stdout: diskInfo } = await execAsync('df -h / | tail -1');
    const diskParts = diskInfo.split(/\s+/);
    const diskUsage = parseInt(diskParts[4]);

    res.json({
      timestamp: new Date().toISOString(),
      hostname: require('os').hostname(),
      gpu: gpuData,
      ram: {
        total_mb: ramTotal,
        used_mb: ramUsed,
        free_mb: ramTotal - ramUsed,
        usage_percent: Math.round((ramUsed / ramTotal) * 100)
      },
      cpu: {
        usage_percent: cpuUsage,
        cores: require('os').cpus().length
      },
      disk: {
        usage_percent: diskUsage,
        mount: '/'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get system resources', message: error.message });
  }
});

app.post('/api/training/data', (req, res) => {
  const { messages, metadata } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const trainingEntry = {
    id: `train_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    messages: messages,
    metadata: {
      ...metadata,
      system_context: 'Ecosystem multi-agent system',
      collected_at: new Date().toISOString()
    },
    created_at: new Date().toISOString()
  };

  trainingData.push(trainingEntry);

  if (wss) {
    const message = JSON.stringify({
      type: 'training_data_added',
      data: { id: trainingEntry.id, message_count: messages.length }
    });
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }

  res.json({
    success: true,
    training_id: trainingEntry.id,
    total_training_entries: trainingData.length
  });
});

app.get('/api/training/datasets', (req, res) => {
  res.json({
    total: trainingData.length,
    datasets: trainingData.map(t => ({
      id: t.id,
      message_count: t.messages.length,
      metadata: t.metadata,
      created_at: t.created_at
    }))
  });
});

app.get('/api/machines', (req, res) => {
  res.json({
    total: 0,
    machines: [],
    source: 'machines-server',
    timestamp: new Date().toISOString()
  });
});


app.post('/api/media/youtube', (req, res) => {
  const { url, title, priority } = req.body;

  if (!url) {
    return res.status(400).json({
      error: 'Missing required field: url'
    });
  }

  const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/);
  if (!videoIdMatch) {
    return res.status(400).json({
      error: 'Invalid YouTube URL'
    });
  }

  const videoId = videoIdMatch[1];

  const task = {
    id: uuidv4(),
    project: 'ecosystem',
    assigned_to: 'worker1',
    created_by: 'Dashboard',
    title: title || `YouTube Transcription: ${videoId}`,
    description: `Example job: ${url}\n\nExecute: scripts/example.sh "${url}"`,
    priority: priority || 'NORMAL',
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    metadata: {
      type: 'youtube_transcription',
      video_id: videoId,
      url: url
    }
  };

  tasks.push(task);
  saveTask(task);

  const log = {
    id: logs.length + 1,
    project: 'ecosystem',
    agent: 'Dashboard',
    level: 'INFO',
    message: `YouTube transcription queued: ${videoId}`,
    task_id: task.id,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  saveLog(log);

  res.status(201).json({
    task_id: task.id,
    video_id: videoId,
    status: task.status,
    message: 'Transcription task created successfully'
  });
});

app.get('/api/media/transcripts', (req, res) => {
  const transcriptTasks = tasks.filter(t =>
    t.metadata && t.metadata.type === 'youtube_transcription'
  );

  const transcripts = transcriptTasks.map(t => ({
    task_id: t.id,
    video_id: t.metadata.video_id,
    url: t.metadata.url,
    title: t.title,
    status: t.status,
    created_at: t.created_at,
    completed_at: t.completed_at
  }));

  res.json({
    total: transcripts.length,
    transcripts: transcripts
  });
});


app.post('/api/logs/append', (req, res) => {
  const { project, agent, level, message, task_id, metadata } = req.body;

  if (!project || !agent || !message) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['project', 'agent', 'message']
    });
  }

  const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
  const logLevel = level && validLevels.includes(level) ? level : 'INFO';

  const log = {
    id: logs.length + 1,
    project: project,
    agent: agent,
    level: logLevel,
    message: message,
    task_id: task_id || null,
    metadata: metadata || null,
    timestamp: getCurrentTimestamp()
  };

  logs.push(log);
  saveLog(log);

  emit('logs', 'log_added', log);

  res.status(201).json({
    log_id: log.id,
    timestamp: log.timestamp
  });
});

app.get('/api/logs/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const project = req.query.project;
  const agent = req.query.agent;
  const level = req.query.level;

  let filteredLogs = [...logs];

  if (project) {
    filteredLogs = filteredLogs.filter(l => l.project === project);
  }
  if (agent) {
    filteredLogs = filteredLogs.filter(l => l.agent === agent);
  }
  if (level) {
    filteredLogs = filteredLogs.filter(l => l.level === level);
  }

  filteredLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const recentLogs = filteredLogs.slice(0, limit);

  res.json(recentLogs);
});


app.get('/api/brainstorm', (req, res) => {
  const project = req.query.project;
  const status = req.query.status;

  let filtered = [...brainstorms];

  if (project) {
    filtered = filtered.filter(b => b.project === project);
  }
  if (status) {
    filtered = filtered.filter(b => b.status === status);
  }

  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    total: filtered.length,
    brainstorms: filtered
  });
});

app.post('/api/brainstorm', (req, res) => {
  const { title, description, project } = req.body;

  if (!title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['title']
    });
  }

  const brainstorm = {
    id: uuidv4(),
    title: title,
    description: description || '',
    project: project || 'ecosystem',
    status: 'NEW',
    created_at: getCurrentTimestamp()
  };

  brainstorms.push(brainstorm);
  saveBrainstorm(brainstorm);

  res.status(201).json({
    brainstorm_id: brainstorm.id,
    created_at: brainstorm.created_at
  });
});

app.delete('/api/brainstorm/:id', (req, res) => {
  const brainstormId = req.params.id;
  const brainstorm = findBrainstormById(brainstormId);

  if (!brainstorm) {
    return res.status(404).json({ error: 'Brainstorm not found' });
  }

  brainstorms = brainstorms.filter(b => b.id !== brainstormId);

  deleteBrainstorm(brainstormId);

  res.json({
    success: true,
    message: 'Brainstorm deleted',
    brainstorm_id: brainstormId
  });
});

app.post('/api/brainstorm/:id/promote', (req, res) => {
  const brainstormId = req.params.id;
  const brainstorm = findBrainstormById(brainstormId);

  if (!brainstorm) {
    return res.status(404).json({ error: 'Brainstorm not found' });
  }

  const { assigned_to, priority } = req.body;

  const task = {
    id: uuidv4(),
    project: brainstorm.project,
    assigned_to: assigned_to || 'worker1',
    created_by: 'Brainstorm',
    title: brainstorm.title,
    description: brainstorm.description,
    priority: priority || 'NORMAL',
    status: 'PENDING',
    created_at: getCurrentTimestamp(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    metadata: {
      promoted_from_brainstorm: brainstormId,
      brainstorm_created_at: brainstorm.created_at
    }
  };

  tasks.push(task);
  saveTask(task);

  emitTaskEvent('task_created', task);

  brainstorms = brainstorms.filter(b => b.id !== brainstormId);
  deleteBrainstorm(brainstormId);

  res.status(201).json({
    success: true,
    message: 'Brainstorm promoted to task',
    task: task,
    brainstorm_id: brainstormId
  });
});


app.get('/api/tasks/:id', (req, res) => {
  const task = findTaskById(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

app.get('/api/tasks', (req, res) => {
  res.json({
    total: tasks.length,
    tasks: tasks
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    tasks: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'PENDING').length,
      in_progress: tasks.filter(t => t.status === 'IN_PROGRESS').length,
      done: tasks.filter(t => t.status === 'DONE').length,
      failed: tasks.filter(t => t.status === 'FAILED').length
    },
    logs: {
      total: logs.length,
      by_level: {
        debug: logs.filter(l => l.level === 'DEBUG').length,
        info: logs.filter(l => l.level === 'INFO').length,
        warn: logs.filter(l => l.level === 'WARN').length,
        error: logs.filter(l => l.level === 'ERROR').length
      }
    },
    agents: {
      total: agents.length
    },
    uptime: Math.floor(process.uptime()),
    memory_usage: process.memoryUsage()
  };

  res.json(stats);
});

app.get('/api/services', async (req, res) => {
  const http = require('http');

  const servicesToCheck = loadServices()
    .filter(s => s.status === 'active')
    .map(s => ({
      name: s.name,
      host: s.host,
      port: s.port,
      path: s.path || '/health',
      description: s.description,
      url: s.name === 'semantic-search' ? process.env.SEMANTIC_SEARCH_URL : undefined,
    }));

  const checkService = (service) => {
    return new Promise((resolve) => {
      const base = service.url || `http://${service.host}:${service.port}`;
      const req = http.get(`${base}${service.path}`, { timeout: 1000 }, (res) => {
        if (res.statusCode === 200 || res.statusCode === 426 || (res.statusCode >= 200 && res.statusCode < 500)) {
          resolve({ ...service, status: 'active' });
        } else {
          resolve({ ...service, status: 'inactive' });
        }
      });

      req.on('error', () => {
        resolve({ ...service, status: 'inactive' });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ...service, status: 'timeout' });
      });
    });
  };

  const results = await Promise.all(servicesToCheck.map(checkService));

  const active = {};
  const inactive = {};

  results.forEach(service => {
    const { name, status, ...rest } = service;
    if (status === 'active') {
      active[name] = { ...rest, status };
    } else {
      inactive[name] = { ...rest, status };
    }
  });

  res.json({
    services: active,
    inactive: inactive,
    checked_at: getCurrentTimestamp()
  });
});


let notes = [];

const noteEmbeddingOutbox = createNoteEmbeddingOutbox({
  redisClient,
  getEmbedUrl: () => {
    const base = process.env.SEMANTIC_SEARCH_URL || 'http://localhost:3037';
    if (!isValidSemanticSearchUrl(base)) return null;
    return `${base.replace(/\/$/, '')}/api/embed`;
  },
  signHeaders,
  initialBackoffMs: parseInt(process.env.NOTE_EMBED_RETRY_INITIAL_MS || '1000', 10),
  maxBackoffMs: parseInt(process.env.NOTE_EMBED_RETRY_MAX_MS || '300000', 10),
  pollIntervalMs: parseInt(process.env.NOTE_EMBED_POLL_MS || '1000', 10),
  requestTimeoutMs: parseInt(process.env.NOTE_EMBED_TIMEOUT_MS || '35000', 10),
});
noteEmbeddingOutbox.start();

async function saveNote(note) {
  const transaction = redisClient.multi();
  persistNoteWithOutbox(transaction, note, {
    ttlSeconds: noteRetentionSeconds(note),
  });
  await transaction.exec();
  noteEmbeddingOutbox.wake();
}

async function deleteNote(id) {
  const transaction = redisClient.multi();
  transaction.del(`note:${id}`);
  transaction.hDel(NOTE_EMBEDDING_OUTBOX_KEY, id);
  await transaction.exec();
}

async function loadNotesFromRedis() {
  try {
    const noteKeys = await redisClient.keys('note:*');
    notes = [];
    for (const key of noteKeys) {
      const data = await redisClient.get(key);
      if (data) notes.push(JSON.parse(data));
    }
    notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    console.log(`📝 Loaded ${notes.length} notes from Redis`);
  } catch (error) {
    console.error('Failed to load notes from Redis:', error);
  }
}


app.post('/api/memory/conversations', async (req, res) => {
  const { agent, session_id, messages, reasoning_chain, metadata, summary } = req.body;

  if (!agent || !messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'messages (array)']
    });
  }

  const conv = {
    id: uuidv4(),
    agent: agent,
    session_id: session_id || uuidv4(),
    messages: messages,
    reasoning_chain: reasoning_chain || [],
    summary: summary || null,
    metadata: {
      ...metadata,
      message_count: messages.length,
      reasoning_steps: reasoning_chain ? reasoning_chain.length : 0
    },
    created_at: getCurrentTimestamp()
  };

  conversations.push(conv);
  await saveConversation(conv);

  emit('system', 'conversation_saved', { id: conv.id, agent: conv.agent, message_count: conv.messages.length });

  const log = {
    id: uuidv4(),
    project: 'ecosystem',
    agent: agent,
    level: 'INFO',
    message: `Conversation saved: ${conv.messages.length} messages, ${conv.reasoning_chain.length} reasoning steps`,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  await saveLog(log);

  res.status(201).json({
    id: conv.id,
    session_id: conv.session_id,
    message_count: conv.messages.length,
    reasoning_steps: conv.reasoning_chain.length,
    created_at: conv.created_at
  });
});

app.get('/api/memory/conversations', (req, res) => {
  const { agent, limit = 20, offset = 0 } = req.query;

  let filtered = conversations;
  if (agent) {
    filtered = filtered.filter(c => c.agent === agent);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    conversations: items
  });
});

app.get('/api/memory/conversations/:id', (req, res) => {
  const conv = conversations.find(c => c.id === req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(conv);
});

app.patch('/api/memory/conversations/:id', async (req, res) => {
  const conv = conversations.find(c => c.id === req.params.id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const { messages, reasoning_chain } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Missing required field',
      required: ['messages (non-empty array)']
    });
  }

  conv.messages.push(...messages);
  if (Array.isArray(reasoning_chain) && reasoning_chain.length > 0) {
    conv.reasoning_chain = conv.reasoning_chain || [];
    conv.reasoning_chain.push(...reasoning_chain);
  }
  conv.metadata = {
    ...conv.metadata,
    message_count: conv.messages.length,
    reasoning_steps: (conv.reasoning_chain || []).length,
    last_appended_at: getCurrentTimestamp(),
  };

  await saveConversation(conv);

  emit('system', 'conversation_appended', { id: conv.id, agent: conv.agent, message_count: conv.messages.length });

  res.json({
    id: conv.id,
    session_id: conv.session_id,
    message_count: conv.messages.length,
    reasoning_steps: (conv.reasoning_chain || []).length,
    last_appended_at: conv.metadata.last_appended_at
  });
});

app.get('/api/memory/search', (req, res) => {
  const { q, agent, limit = 10 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  const searchTerm = q.toLowerCase();

  let results = [];

  for (const conv of conversations) {
    if (agent && conv.agent !== agent) continue;

    for (const msg of conv.messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchTerm)) {
        results.push({
          type: 'conversation',
          conversation_id: conv.id,
          agent: conv.agent,
          match: msg.content.substring(0, 200),
          created_at: conv.created_at
        });
        break;
      }
    }

    for (const step of conv.reasoning_chain || []) {
      if ((step.thought && step.thought.toLowerCase().includes(searchTerm)) ||
          (step.conclusion && step.conclusion.toLowerCase().includes(searchTerm))) {
        results.push({
          type: 'reasoning',
          conversation_id: conv.id,
          agent: conv.agent,
          step: step.step,
          match: step.thought || step.conclusion,
          created_at: conv.created_at
        });
        break;
      }
    }
  }

  for (const data of trainingData) {
    if (agent && data.metadata?.agent !== agent) continue;

    if ((data.input && data.input.toLowerCase().includes(searchTerm)) ||
        (data.output && data.output.toLowerCase().includes(searchTerm))) {
      results.push({
        type: 'training',
        training_id: data.id,
        data_type: data.type,
        match: (data.input + ' ' + data.output).substring(0, 200),
        created_at: data.created_at
      });
    }
  }

  results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  results = results.slice(0, Number(limit));

  res.json({
    query: q,
    total: results.length,
    results: results
  });
});

app.post('/api/memory/training', async (req, res) => {
  const { type, goal, instruction, input, output, reasoning_chain, final_answer, metadata, quality } = req.body;

  if (!type) {
    return res.status(400).json({
      error: 'Missing required field: type',
      valid_types: ['troubleshooting', 'exploration', 'implementation', 'explanation', 'architecture', 'ui_mapping']
    });
  }

  const data = {
    id: uuidv4(),
    type: type,
    goal: goal || instruction,
    instruction: instruction,
    input: input,
    output: output || final_answer,
    reasoning_chain: reasoning_chain || [],
    final_answer: final_answer || output,
    quality: quality || 'draft',
    metadata: {
      ...metadata,
      reasoning_steps: reasoning_chain ? reasoning_chain.length : 0
    },
    created_at: getCurrentTimestamp()
  };

  trainingData.push(data);
  await saveTrainingData(data);

  emit('system', 'training_data_saved', { id: data.id, type: data.type, quality: data.quality });

  res.status(201).json({
    id: data.id,
    type: data.type,
    quality: data.quality,
    reasoning_steps: data.reasoning_chain.length,
    created_at: data.created_at
  });
});

app.get('/api/memory/training', (req, res) => {
  const { type, quality, limit = 50, offset = 0, format } = req.query;

  let filtered = trainingData;

  if (type) {
    filtered = filtered.filter(d => d.type === type);
  }
  if (quality) {
    filtered = filtered.filter(d => d.quality === quality);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  if (format === 'jsonl') {
    const jsonl = items.map(d => {
      return JSON.stringify({
        instruction: d.instruction || d.goal,
        input: d.input || '',
        output: d.output || d.final_answer,
        reasoning: d.reasoning_chain
      });
    }).join('\n');

    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', 'attachment; filename=training-data.jsonl');
    return res.send(jsonl);
  }

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    training_data: items
  });
});

app.patch('/api/memory/training/:id', async (req, res) => {
  const { quality, tags } = req.body;
  const data = trainingData.find(d => d.id === req.params.id);

  if (!data) {
    return res.status(404).json({ error: 'Training data not found' });
  }

  if (quality) {
    const validQualities = ['draft', 'verified', 'exported', 'rejected'];
    if (!validQualities.includes(quality)) {
      return res.status(400).json({ error: 'Invalid quality', valid: validQualities });
    }
    data.quality = quality;
  }
  if (tags) {
    data.metadata = { ...data.metadata, tags: tags };
  }
  data.updated_at = getCurrentTimestamp();

  await saveTrainingData(data);

  res.json({
    id: data.id,
    quality: data.quality,
    updated_at: data.updated_at
  });
});

app.post('/api/memory/summaries', async (req, res) => {
  const { agent, session_id, summary, key_actions, blockers, todos, sentiment, metadata } = req.body;

  if (!agent || !session_id || !summary) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'session_id', 'summary']
    });
  }

  const summaryDoc = {
    id: uuidv4(),
    agent: agent,
    session_id: session_id,
    summary: summary,
    key_actions: key_actions || [],
    blockers: blockers || [],
    todos: todos || [],
    sentiment: sentiment || 'neutral',
    metadata: metadata || {},
    timestamp: getCurrentTimestamp()
  };

  summaries.push(summaryDoc);
  await saveSummary(summaryDoc);

  try {
    const semanticUrlRaw = process.env.SEMANTIC_SEARCH_URL || 'http://localhost:3037';
    if (!isValidSemanticSearchUrl(semanticUrlRaw)) {
      console.warn(`[summaries] SEMANTIC_SEARCH_URL is not a valid http(s) URL: ${JSON.stringify(semanticUrlRaw)} — skipping auto-embed`);
      return res.status(201).json(summaryDoc);
    }
    const embedText = `Agent: ${agent}\nSummary: ${summary}\nActions: ${(key_actions || []).join(', ')}`;
    const embedUrl = `${semanticUrlRaw}/api/embed`;
    const embedBody = JSON.stringify({
      collection: 'session_summaries',
      id: summaryDoc.id,
      text: embedText,
      metadata: {
        agent: agent,
        session_id: session_id,
        timestamp: summaryDoc.timestamp,
        sentiment: sentiment || 'neutral'
      }
    });
    const response = await fetch(embedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signHeaders(null, 'POST', new URL(embedUrl).pathname, embedBody)
      },
      body: embedBody
    });

    if (!response.ok) {
      console.error('Failed to embed summary to ChromaDB:', await response.text());
    } else {
      console.log(`✅ Summary embedded to ChromaDB: ${summaryDoc.id}`);
    }
  } catch (error) {
    console.error('Error embedding summary:', error);
  }

  emit('system', 'summary_saved', { id: summaryDoc.id, agent: summaryDoc.agent, session_id: summaryDoc.session_id });

  const log = {
    id: uuidv4(),
    project: 'ecosystem',
    agent: agent,
    level: 'INFO',
    message: `Summary saved for session ${session_id.substring(0, 8)}...`,
    timestamp: getCurrentTimestamp()
  };
  logs.push(log);
  await saveLog(log);

  res.status(201).json({
    id: summaryDoc.id,
    agent: summaryDoc.agent,
    session_id: summaryDoc.session_id,
    timestamp: summaryDoc.timestamp,
    embedded: true
  });
});

app.get('/api/memory/summaries', (req, res) => {
  const { agent, session_id, limit = 20, offset = 0 } = req.query;

  let filtered = summaries;

  if (agent) {
    filtered = filtered.filter(s => s.agent === agent);
  }
  if (session_id) {
    filtered = filtered.filter(s => s.session_id === session_id);
  }

  const total = filtered.length;
  const items = filtered.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total: total,
    limit: Number(limit),
    offset: Number(offset),
    summaries: items
  });
});

app.get('/api/memory/summaries/:id', (req, res) => {
  const summary = summaries.find(s => s.id === req.params.id);
  if (!summary) {
    return res.status(404).json({ error: 'Summary not found' });
  }
  res.json(summary);
});

app.get('/api/memory/stats', (req, res) => {
  const convsByAgent = {};
  for (const c of conversations) {
    convsByAgent[c.agent] = (convsByAgent[c.agent] || 0) + 1;
  }

  const trainingByType = {};
  const trainingByQuality = {};
  let totalReasoningSteps = 0;

  for (const d of trainingData) {
    trainingByType[d.type] = (trainingByType[d.type] || 0) + 1;
    trainingByQuality[d.quality] = (trainingByQuality[d.quality] || 0) + 1;
    totalReasoningSteps += d.reasoning_chain?.length || 0;
  }

  res.json({
    conversations: {
      total: conversations.length,
      by_agent: convsByAgent,
      total_messages: conversations.reduce((sum, c) => sum + c.messages.length, 0)
    },
    training_data: {
      total: trainingData.length,
      by_type: trainingByType,
      by_quality: trainingByQuality,
      total_reasoning_steps: totalReasoningSteps,
      ready_for_export: trainingData.filter(d => d.quality === 'verified').length
    }
  });
});


app.post('/api/notes', async (req, res) => {
  const { agent, type, title, content, tags, visibility, expires_at, metadata } = req.body;

  if (!agent || !type || !title) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'type', 'title']
    });
  }

  if (!NoteTypeValues.includes(type)) {
    return res.status(400).json({
      error: 'Invalid type',
      valid_types: NoteTypeValues
    });
  }

  const note = {
    id: uuidv4(),
    agent: agent,
    type: type,
    title: title,
    content: content || '',
    tags: tags || [],
    visibility: visibility || 'all',
    metadata: metadata || null,
    expires_at: expires_at || null,
    created_at: getCurrentTimestamp(),
    updated_at: getCurrentTimestamp()
  };

  notes.push(note);
  await saveNote(note);

  broadcastToWs({ type: 'note_created', data: note });

  res.status(201).json(note);
});

app.post('/api/inbox/documents', async (req, res) => {
  let envelope;
  try {
    const maxBytes = parseInt(process.env.INBOX_MAX_ATTACHMENT_BYTES || String(DEFAULT_MAX_ATTACHMENT_BYTES), 10);
    envelope = parseInboxEnvelope(req.body, maxBytes);
  } catch (error) {
    const status = error instanceof InboxValidationError ? error.status : 400;
    return res.status(status).json({ error: 'invalid_inbox_document', reason: error.message });
  }

  const agent = req._verifiedAgent;
  const timestamp = getCurrentTimestamp();
  const note = buildInboxNote(envelope, agent, timestamp);
  const requestFingerprint = fingerprintEnvelope(envelope);
  const resultKey = `inbox:result:${note.id}`;
  const lockKey = `inbox:lock:${note.id}`;
  const existingRaw = await redisClient.get(resultKey);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.request_fingerprint !== requestFingerprint) {
      return res.status(409).json({ error: 'idempotency_conflict', note_id: existing.note_id });
    }
    return res.status(200).json({ ...existing, duplicate: true });
  }

  const lockToken = uuidv4();
  const acquired = await redisClient.set(lockKey, lockToken, { NX: true, PX: 60000 });
  if (!acquired) return res.status(409).json({ error: 'ingest_in_progress', retryable: true });

  try {
    const attachmentDir = process.env.INBOX_ATTACHMENT_DIR || '';
    await storeAttachment(attachmentDir, envelope);
    await saveNote(note);
    if (!notes.some(item => item.id === note.id)) notes.push(note);
    const result = {
      note_id: note.id,
      attachment_id: envelope.sha256,
      attachment_url: `/api/inbox/attachments/${envelope.sha256}`,
      sha256: envelope.sha256,
      request_fingerprint: requestFingerprint,
      created_at: timestamp,
    };
    await persistWithRetention(resultKey, result, retentionSeconds('inbox.result'));
    broadcastToWs({ type: 'note_created', data: note });
    return res.status(201).json({ ...result, duplicate: false });
  } catch (error) {
    console.error(`[inbox] ${note.id} failed: ${error.message}`);
    return res.status(503).json({ error: 'ingest_failed', retryable: true, reason: error.message });
  } finally {
    const currentToken = await redisClient.get(lockKey).catch(() => null);
    if (currentToken === lockToken) await redisClient.del(lockKey).catch(() => {});
  }
});

app.get('/api/inbox/attachments/:sha256', async (req, res) => {
  const digest = String(req.params.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) return res.status(400).json({ error: 'invalid_attachment_id' });
  const attachmentDir = process.env.INBOX_ATTACHMENT_DIR || '';
  if (!attachmentDir) return res.status(503).json({ error: 'inbox_storage_unconfigured' });
  const filename = path.resolve(attachmentDir, digest);
  try {
    await fs.promises.access(filename, fs.constants.R_OK);
    return res.type('application/octet-stream').sendFile(filename);
  } catch (error) {
    return res.status(404).json({ error: 'attachment_not_found' });
  }
});

app.get('/api/notes', (req, res) => {
  const { agent, type, tag, limit, since } = req.query;
  const maxLimit = parseInt(limit) || 50;

  let filtered = [...notes];

  if (agent) {
    filtered = filtered.filter(n => n.agent === agent);
  }
  if (type) {
    filtered = filtered.filter(n => n.type === type);
  }
  if (tag) {
    filtered = filtered.filter(n => n.tags && n.tags.includes(tag));
  }
  if (since) {
    const sinceDate = new Date(since);
    filtered = filtered.filter(n => new Date(n.created_at) > sinceDate);
  }

  const now = new Date();
  filtered = filtered.filter(n => !n.expires_at || new Date(n.expires_at) > now);

  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    total: filtered.length,
    notes: filtered.slice(0, maxLimit)
  });
});

app.get('/api/notes/recent', (req, res) => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const recentNotes = notes.filter(n => 
    new Date(n.created_at) > yesterday &&
    (!n.expires_at || new Date(n.expires_at) > new Date())
  );

  res.json({
    total: recentNotes.length,
    notes: recentNotes
  });
});

app.get('/api/notes/:id', (req, res) => {
  const note = notes.find(n => n.id === req.params.id);
  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }
  res.json(note);
});

app.delete('/api/notes/:id', async (req, res) => {
  const noteId = req.params.id;
  const note = notes.find(n => n.id === noteId);

  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }

  notes = notes.filter(n => n.id !== noteId);
  await deleteNote(noteId);

  res.json({
    success: true,
    message: 'Note deleted',
    note_id: noteId
  });
});


app.get('/api/briefing/:agent', (req, res) => {
  const agentName = req.params.agent.toUpperCase();
  const hours = parseInt(req.query.hours) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const agent = findAgentByName(agentName);
  const lastSeen = agent ? new Date(agent.last_heartbeat) : since;
  const hoursOffline = agent ? Math.floor((Date.now() - lastSeen) / (1000 * 60 * 60)) : hours;

  const tasksForAgent = tasks.filter(t =>
    t.assigned_to === agentName &&
    new Date(t.created_at) > lastSeen
  );

  const tasksCompletedByOthers = tasks.filter(t =>
    t.assigned_to !== agentName &&
    t.status === 'DONE' &&
    t.completed_at &&
    new Date(t.completed_at) > lastSeen
  );

  const chatMentions = chatMessages.filter(m =>
    (m.mentions.includes(agentName) || m.mentions.includes('ALL')) &&
    m.from !== agentName &&
    new Date(m.timestamp) > lastSeen
  );

  const recentNotes = notes.filter(n =>
    new Date(n.created_at) > lastSeen &&
    (!n.expires_at || new Date(n.expires_at) > new Date())
  );

  const handoffs = notes.filter(n =>
    n.type === 'session_end' || n.type === 'handoff' &&
    new Date(n.created_at) > lastSeen
  );

  const now = new Date();
  const activeAgents = agents
    .filter(a => {
      const lastHB = new Date(a.last_heartbeat);
      return (now - lastHB) / 1000 < 120 && a.name !== agentName;
    })
    .map(a => a.name);

  const pendingTasks = tasks.filter(t =>
    t.assigned_to === agentName && t.status === 'PENDING'
  );

  const priorities = [];
  
  pendingTasks
    .filter(t => t.priority === 'URGENT' || t.priority === 'HIGH')
    .forEach(t => priorities.push(`[${t.priority}] Task: ${t.title}`));
  
  recentNotes
    .filter(n => n.type === 'blocker' || n.type === 'decision')
    .forEach(n => priorities.push(`[${n.type.toUpperCase()}] ${n.title}`));
  
  if (chatMentions.length > 0) {
    priorities.push(`${chatMentions.length} unread chat mention(s)`);
  }

  res.json({
    agent: agentName,
    last_seen: lastSeen.toISOString(),
    hours_offline: hoursOffline,
    generated_at: getCurrentTimestamp(),

    while_you_were_away: {
      tasks_created_for_you: tasksForAgent.length,
      tasks_completed_by_others: tasksCompletedByOthers.length,
      chat_mentions: chatMentions.length,
      notes_created: recentNotes.length,
      handoffs: handoffs.length
    },

    current_state: {
      your_pending_tasks: pendingTasks.length,
      active_agents: activeAgents,
      system_health: 'ok'
    },

    priorities: priorities.slice(0, 10),

    details: {
      new_tasks: tasksForAgent.map(t => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        created_by: t.created_by
      })),
      chat_mentions: chatMentions.slice(-10).map(m => ({
        from: m.from,
        content: m.content.substring(0, 100),
        timestamp: m.timestamp
      })),
      recent_notes: recentNotes.slice(0, 5).map(n => ({
        agent: n.agent,
        type: n.type,
        title: n.title,
        created_at: n.created_at
      })),
      handoffs: handoffs.map(h => ({
        agent: h.agent,
        title: h.title,
        content: h.content,
        created_at: h.created_at
      }))
    }
  });
});


app.post('/api/sessions/end', async (req, res) => {
  const { agent, summary, blockers, next_steps, handoff_to } = req.body;

  if (!agent || !summary) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['agent', 'summary']
    });
  }

  const note = {
    id: uuidv4(),
    agent: agent,
    type: 'session_end',
    title: `${agent} session ended`,
    content: summary,
    tags: ['session', 'handoff'],
    visibility: 'all',
    metadata: {
      blockers: blockers || [],
      next_steps: next_steps || [],
      handoff_to: handoff_to || null
    },
    expires_at: null,
    created_at: getCurrentTimestamp(),
    updated_at: getCurrentTimestamp()
  };

  notes.push(note);
  await saveNote(note);

  broadcastToWs({ type: 'session_ended', data: note });

  if (handoff_to) {
    broadcastToWs({
      type: 'handoff',
      data: {
        from: agent,
        to: handoff_to,
        summary: summary,
        next_steps: next_steps
      }
    });
  }

  res.status(201).json({
    success: true,
    note_id: note.id,
    message: `Session summary recorded for ${agent}`
  });
});

app.get('/api/sessions/latest', (req, res) => {
  const sessionNotes = notes.filter(n => n.type === 'session_end');
  
  const latestByAgent = {};
  sessionNotes.forEach(n => {
    if (!latestByAgent[n.agent] || 
        new Date(n.created_at) > new Date(latestByAgent[n.agent].created_at)) {
      latestByAgent[n.agent] = n;
    }
  });

  res.json({
    sessions: Object.values(latestByAgent)
  });
});




app.get("/api/transcripts", (req, res) => {
  const transcriptsDir = path.join(process.env.HOME, "project-memory/transcripts");
  
  try {
    if (!fs.existsSync(transcriptsDir)) {
      return res.json({ transcripts: [] });
    }
    
    const files = fs.readdirSync(transcriptsDir)
      .filter(f => f.endsWith(".md"))
      .map(f => ({
        filename: f,
        path: path.join(transcriptsDir, f),
        size: fs.statSync(path.join(transcriptsDir, f)).size,
        modified: fs.statSync(path.join(transcriptsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    res.json({ transcripts: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/transcripts/:filename", (req, res) => {
  const { filename } = req.params;
  const transcriptsDir = path.join(process.env.HOME, "project-memory/transcripts");
  const filepath = path.join(transcriptsDir, filename);
  
  if (!filepath.startsWith(transcriptsDir)) {
    return res.status(403).json({ error: "Access denied" });
  }
  
  try {
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: "Transcript not found" });
    }
    
    const content = fs.readFileSync(filepath, "utf-8");
    res.json({ 
      filename,
      content,
      size: content.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



let daemons = [];

app.post("/api/daemons/heartbeat", (req, res) => {
  const { name, type, agent, status, metadata } = req.body;
  
  if (!name || !type || !agent) {
    return res.status(400).json({ error: "Missing required fields: name, type, agent" });
  }
  
  const validTypes = ["worker", "watcher"];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: "Invalid type. Use: worker or watcher" });
  }
  
  const existing = daemons.find(d => d.name === name);
  const now = getCurrentTimestamp();
  
  if (existing) {
    existing.last_heartbeat = now;
    existing.status = status || existing.status || "running";
    if (metadata) existing.metadata = { ...existing.metadata, ...metadata };
  } else {
    daemons.push({
      name,
      type,
      agent,
      status: status || "running",
      metadata: metadata || {},
      registered_at: now,
      last_heartbeat: now
    });
  }
  
  res.json({ success: true, daemon: name, heartbeat: now });
});

app.get("/api/daemons", (req, res) => {
  const now = new Date();
  const TIMEOUT_SECONDS = 120;
  
  const result = daemons.map(d => {
    const lastHB = new Date(d.last_heartbeat);
    const secondsAgo = Math.floor((now - lastHB) / 1000);
    const online = secondsAgo < TIMEOUT_SECONDS;
    
    return {
      ...d,
      online,
      seconds_since_heartbeat: secondsAgo
    };
  });
  
  res.json({ daemons: result });
});

app.get("/api/daemons/:agent", (req, res) => {
  const { agent } = req.params;
  const now = new Date();
  const TIMEOUT_SECONDS = 120;
  
  const agentDaemons = daemons
    .filter(d => d.agent === agent)
    .map(d => {
      const lastHB = new Date(d.last_heartbeat);
      const secondsAgo = Math.floor((now - lastHB) / 1000);
      return {
        ...d,
        online: secondsAgo < TIMEOUT_SECONDS,
        seconds_since_heartbeat: secondsAgo
      };
    });
  
  res.json({ agent, daemons: agentDaemons });
});


async function saveChatMessage(msg) {
  try {
    await chatArchive.journal(msg);
  } catch (error) {
    console.error(`[chat-archive] journal failed for ${msg.id}: ${error.message}`);
  }
  await persistWithRetention(`chat:${msg.id}`, msg, retentionSeconds('chat'));
}

async function loadChatFromRedis() {
  const chatKeys = await redisClient.keys("chat:*");
  chatMessages = [];
  for (const key of chatKeys) {
    const data = await redisClient.get(key);
    if (data) chatMessages.push(JSON.parse(data));
  }
  chatMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  console.log(`📨 Loaded ${chatMessages.length} chat messages from Redis`);
}

function extractMentions(content) {
  if (typeof content !== 'string') return [];

  const registeredAgents = new Map();
  for (const agent of agents) {
    if (agent == null || agent.name == null) continue;
    const name = String(agent.name);
    if (!name) continue;
    registeredAgents.set(name.toUpperCase(), name);
  }
  registeredAgents.set('ALL', 'ALL');

  const mentions = [];
  const mentionRegex = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  for (const match of content.matchAll(mentionRegex)) {
    const key = match[1].toUpperCase();
    const canonicalName = registeredAgents.get(key);
    if (canonicalName && !mentions.includes(canonicalName)) {
      mentions.push(canonicalName);
    }
  }
  return mentions;
}

app.get("/api/chat", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const since = req.query.since;
  
  let messages = [...chatMessages];
  
  if (since) {
    const sinceDate = new Date(since);
    messages = messages.filter(m => new Date(m.timestamp) > sinceDate);
  }
  
  messages = messages.slice(-limit);
  
  res.json({ 
    messages,
    total: messages.length
  });
});

function authorshipMismatch(req, claimed) {
  const verified = req._verifiedAgent;
  if (!verified || !claimed) return null;
  if (String(claimed) === String(verified)) return null;
  return {
    error: 'authorship_mismatch',
    reason: `podpisano jako ${verified}, a pole from mówi ${claimed}`,
    signed_as: verified,
    claimed_as: claimed,
  };
}

app.post("/api/chat", async (req, res) => {
  const { from, content } = req.body;

  const mismatch = authorshipMismatch(req, from);
  if (mismatch) {
    console.warn(`[AUTH] odrzucono podszycie: ${mismatch.reason}`);
    return res.status(403).json(mismatch);
  }

  const chatRateLimitError = checkRateLimit(from || req.agentName, 'chatMessages');
  if (chatRateLimitError) {
    console.log(`[RATE-LIMIT] Agent ${from || req.agentName} exceeded chat message limit`);
    return res.status(429).json(chatRateLimitError);
  }
  
  if (!from || !content) {
    return res.status(400).json({ error: "Missing required fields: from, content" });
  }
  
  const msg = {
    id: uuidv4(),
    from: from,
    content: content,
    mentions: extractMentions(content),
    timestamp: getCurrentTimestamp()
  };
  
  await saveChatMessage(msg);
  chatMessages.push(msg);
  recordRateLimitAction(msg.from || req.agentName, 'chatMessages');
  
  emit('chat', 'chat_message', msg);
  
  notifyMentionedAgents(msg);
  res.status(201).json({ 
    message_id: msg.id,
    timestamp: msg.timestamp,
    mentions: msg.mentions
  });
});

app.get("/api/chat/mentions/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  const limit = parseInt(req.query.limit) || 20;
  const unread = req.query.unread === "true";
  
  let messages = chatMessages.filter(m => 
    m.mentions.includes(agent) || m.mentions.includes("ALL")
  );
  
  messages = messages.slice(-limit);
  
  res.json({
    agent,
    messages,
    total: messages.length
  });
});


app.get("/api/ws/clients-status", (req, res) => {
  const clients = [];
  wsClients.forEach((info, ws) => {
    clients.push({
      agent: info.agent,
      connected_at: info.connected_at,
      state: ws.readyState === 1 ? "open" : "closed"
    });
  });
  res.json({ clients, total: clients.length });
});


const { exec, execFile } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

const SYSTEMD_UNIT_RE = /^[a-zA-Z0-9._@:-]+$/;

const SYSTEMD_SCOPE_SETTING = (process.env.SYSTEMD_SCOPE || 'auto').toLowerCase();
let _systemdScope = null;

async function detectSystemdScope() {
  if (_systemdScope !== null) return _systemdScope;

  if (['user', 'system', 'none'].includes(SYSTEMD_SCOPE_SETTING)) {
    _systemdScope = SYSTEMD_SCOPE_SETTING;
    return _systemdScope;
  }

  try {
    await execFilePromise('systemctl', ['--version']);
  } catch (err) {
    _systemdScope = 'none';
    console.log('[system] systemctl not available — service endpoints will report source.available=false');
    return _systemdScope;
  }

  try {
    await execFilePromise('systemctl', ['--user', 'list-units', '--type=service', '--no-pager', '--no-legend']);
    _systemdScope = 'user';
  } catch (err) {
    _systemdScope = 'system';
  }
  console.log(`[system] systemd scope detected: ${_systemdScope}`);
  return _systemdScope;
}

function systemdArgs(scope) {
  return scope === 'user' ? ['--user'] : [];
}

const ECOSYSTEM_UNIT_HINTS = (process.env.ECOSYSTEM_UNITS ||
  'consciousness,websocket,dashboard,cleanup,skills,machines,semantic')
  .split(',').map(s => s.trim()).filter(Boolean);

app.get("/api/system/tree", async (req, res) => {
  try {
    const basePath = ECOSYSTEM_ROOT;

    if (!fs.existsSync(basePath)) {
      return res.json({
        tree: null,
        source: { available: false, path: basePath, reason: 'directory not present; set ECOSYSTEM_ROOT' }
      });
    }

    function scanDirectory(dirPath) {
      const entries = [];
      const items = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const item of items) {
        if (item.name === 'node_modules' || item.name === '.git') continue;

        const fullPath = path.join(dirPath, item.name);
        const relativePath = fullPath.replace(basePath, '');

        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            type: 'directory',
            path: relativePath,
            children: scanDirectory(fullPath)
          });
        } else {
          const ext = path.extname(item.name);
          entries.push({
            name: item.name,
            type: 'file',
            path: relativePath,
            extension: ext,
            size: fs.statSync(fullPath).size
          });
        }
      }

      return entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    const tree = {
      name: 'mcp',
      type: 'directory',
      path: '/',
      children: scanDirectory(basePath)
    };

    res.json({ tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/system/services", async (req, res) => {
  const scope = await detectSystemdScope();

  if (scope === 'none') {
    return res.json({
      services: [],
      source: { available: false, scope: 'none', reason: 'systemctl not present in this environment' }
    });
  }

  try {
    const { stdout } = await execFilePromise(
      'systemctl',
      [...systemdArgs(scope), 'list-units', '--type=service', '--all', '--no-pager', '--output=json']
    );
    const services = JSON.parse(stdout);

    const ecosystemServices = services.filter(s => ECOSYSTEM_UNIT_HINTS.some(hint => s.unit.includes(hint)));

    const detailedServices = [];
    for (const svc of ecosystemServices) {
      const name = svc.unit;

      if (!SYSTEMD_UNIT_RE.test(name)) {
        continue;
      }
      let enabled = 'disabled';
      try {
        const { stdout: statusOut } = await execFilePromise('systemctl', [...systemdArgs(scope), 'is-enabled', name]);
        enabled = statusOut.trim();
      } catch (err) {
      }

      detailedServices.push({
        name: name,
        active: svc.active === 'active',
        enabled: enabled === 'enabled',
        state: svc.sub,
        description: svc.description
      });
    }

    res.json({
      services: detailedServices,
      source: { available: true, scope, matched: detailedServices.length, scanned: services.length }
    });
  } catch (error) {
    res.status(500).json({ error: error.message, source: { available: false, scope } });
  }
});

app.post("/api/system/services/:name/:action", async (req, res) => {
  const { name, action } = req.params;

  const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
  }

  if (!SYSTEMD_UNIT_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  const scope = await detectSystemdScope();
  if (scope === 'none') {
    return res.status(503).json({
      success: false,
      service: name,
      action: action,
      error: 'systemctl not present in this environment',
      source: { available: false, scope: 'none' }
    });
  }

  try {
    const { stdout, stderr } = await execFilePromise('systemctl', [...systemdArgs(scope), action, name]);

    res.json({
      success: true,
      service: name,
      action: action,
      scope,
      output: stdout || stderr
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      service: name,
      action: action,
      scope,
      error: error.message
    });
  }
});

app.get("/api/system/ports", (req, res) => {
  const portsPath = process.env.PORTS_JSON || path.join(ECOSYSTEM_ROOT, 'config', 'ports.json');

  if (!fs.existsSync(portsPath)) {
    return res.json({
      ports: null,
      source: { available: false, path: portsPath, reason: 'registry not present; set PORTS_JSON or ECOSYSTEM_ROOT' }
    });
  }

  try {
    const ports = JSON.parse(fs.readFileSync(portsPath, 'utf8'));
    res.json(ports);
  } catch (error) {
    res.status(500).json({ error: error.message, source: { available: false, path: portsPath } });
  }
});

app.get("/api/system/services/:name/logs", async (req, res) => {
  const { name } = req.params;
  const lines = parseInt(req.query.lines) || 50;

  if (!SYSTEMD_UNIT_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid service name' });
  }
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000) {
    return res.status(400).json({ error: 'Invalid lines parameter' });
  }

  const scope = await detectSystemdScope();
  if (scope === 'none') {
    return res.json({
      service: name,
      lines: [],
      count: 0,
      requested: lines,
      source: { available: false, scope: 'none', reason: 'journalctl not present in this environment' }
    });
  }

  try {
    const { stdout } = await execFilePromise(
      'journalctl', [...systemdArgs(scope), '-u', name, '-n', String(lines), '--no-pager', '--output=short-iso']
    );

    const logLines = stdout.split('\n').filter(line => line.trim());

    res.json({
      service: name,
      lines: logLines,
      count: logLines.length,
      requested: lines,
      source: { available: true, scope }
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      service: name,
      source: { available: false, scope }
    });
  }
});

app.get("/api/ws/clients", (req, res) => {
  const clients = [];
  wsClients.forEach((info, ws) => {
    clients.push({
      agent: info.agent,
      connected_at: info.connected_at,
      channels: Array.from(info.channels),
      state: ws.readyState === 1 ? "open" : "closed"
    });
  });
  res.json({
    clients,
    total: clients.length,
    available_channels: WS_CHANNELS
  });
});



let agentTokens = {};
let agentIdentities = {};

app.post("/api/identity/login", (req, res) => {
  const { agent_id, agent_name, machine_id, capabilities, role, style, allowed_machines } = req.body;
  if (!agent_id) return res.status(400).json({ error: "agent_id required" });
  const token = "token-" + agent_id + "-" + Date.now();
  agentTokens[token] = { agent_id, agent_name: agent_name || agent_id, machine_id: machine_id || "unknown", created_at: new Date().toISOString(), last_used: new Date().toISOString() };
  agentIdentities[agent_id] = { name: agent_name || agent_id, machine_id: machine_id || "unknown", capabilities: capabilities || [], role: role || "worker", style: style || "", allowed_machines: allowed_machines || [], created_at: agentIdentities[agent_id]?.created_at || new Date().toISOString(), last_login: new Date().toISOString() };
  res.json({ success: true, token, agent_id, message: "Agent logged in", session: agentTokens[token] });
});

app.get("/api/identity/agents", (req, res) => {
  const agents = Object.entries(agentIdentities).map(([id, data]) => ({ agent_id: id, ...data }));
  res.json({ total: agents.length, agents });
});


app.post("/api/identity/whoami", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  const session = agentTokens[token];
  if (!session) return res.status(401).json({ error: "Invalid token" });
  agentTokens[token].last_used = new Date().toISOString();
  res.json({ agent_id: session.agent_id, identity: agentIdentities[session.agent_id], session });
});

let a2aMessages = [];

app.post("/api/a2a/send", (req, res) => {
  const { from_agent, to_agent, message_type, payload, priority, requires_ack } = req.body;
  if (!from_agent || !to_agent || !message_type) return res.status(400).json({ error: "Missing required fields" });
  const message = { id: require("crypto").randomUUID(), from_agent, to_agent, message_type, payload: payload || {}, priority: priority || "normal", requires_ack: requires_ack || false, status: "pending", created_at: new Date().toISOString() };
  a2aMessages.push(message);
  res.json({ success: true, message_id: message.id, status: "queued" });
});

app.get("/api/a2a/inbox/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  let messages = a2aMessages.filter(m => m.to_agent.toUpperCase() === agent && m.status === "pending");
  messages.forEach(m => { m.status = "delivered"; m.delivered_at = new Date().toISOString(); });
  res.json({ agent, messages, count: messages.length });
});

app.post("/api/a2a/ack/:message_id", (req, res) => {
  const msg = a2aMessages.find(m => m.id === req.params.message_id);
  if (!msg) return res.status(404).json({ error: "Message not found" });
  const { agent } = req.body;
  if (agent && msg.to_agent.toUpperCase() !== agent.toUpperCase()) return res.status(403).json({ error: "Not authorized" });
  msg.status = "acked"; msg.acked_at = new Date().toISOString();
  res.json({ success: true, message_id: msg.id, status: "acked" });
});

app.get("/api/a2a/stats", (req, res) => {
  res.json({ total_messages: a2aMessages.length, by_status: { pending: a2aMessages.filter(m => m.status === "pending").length, delivered: a2aMessages.filter(m => m.status === "delivered").length, acked: a2aMessages.filter(m => m.status === "acked").length } });
});



const AGENTS_DIR = process.env.AGENTS_DIR || path.join(ECOSYSTEM_ROOT, "agents");
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(ECOSYSTEM_ROOT, "skills");

const RESOURCE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function loadAgentsFromDir() {
  const configs = {};
  try {
    const files = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith(".md") && f.toUpperCase() !== "README.MD");
    for (const file of files) {
      try {
        const agent = path.basename(file, ".md").toUpperCase();
        const claude_md = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
        if (claude_md.trim().length > 0) {
          configs[agent] = claude_md;
        }
      } catch (e) {
        console.error(`Error loading agent ${file}:`, e.message);
      }
    }
    console.log(`Loaded ${Object.keys(configs).length} agents from ${AGENTS_DIR}`);
  } catch (e) {
    console.error("Error reading agents directory:", e.message);
  }
  return configs;
}

let claudeMdConfigs = loadAgentsFromDir();

app.get("/api/identity/claude-md", (req, res) => {
  claudeMdConfigs = loadAgentsFromDir();
  res.json({ agents: Object.keys(claudeMdConfigs), total: Object.keys(claudeMdConfigs).length });
});

app.get("/api/identity/claude-md/:agent", (req, res) => {
  const agent = req.params.agent.toUpperCase();
  const config = claudeMdConfigs[agent];
  if (!config) {
    claudeMdConfigs = loadAgentsFromDir();
    const reloaded = claudeMdConfigs[agent];
    if (!reloaded) {
      return res.status(404).json({ error: "Agent not found", available: Object.keys(claudeMdConfigs) });
    }
    return res.json({ agent, claude_md: reloaded, updated_at: new Date().toISOString() });
  }
  res.json({ agent, claude_md: config, updated_at: new Date().toISOString() });
});


app.get("/api/skills", (req, res) => {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
    const skills = files.map(f => ({ name: path.basename(f, ".md") }));
    res.json({ skills, count: skills.length });
  } catch (err) {
    res.status(500).json({ error: "skills_dir_unreadable", detail: err.message });
  }
});

app.get("/api/skills/:name", (req, res) => {
  const name = req.params.name;
  if (!RESOURCE_NAME_RE.test(name)) {
    return res.status(400).json({ error: "invalid_skill_name" });
  }
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "skill_not_found", name });
  }
  res.json({ name, content: fs.readFileSync(filePath, "utf8") });
});

app.get("/.well-known/agent.json", (req, res) => {
  res.json({
    name: "Ecosystem Agent Network",
    description: "Multi-agent AI development system",
    ...(PUBLIC_URL ? { url: PUBLIC_URL } : {}),
    version: "1.0.0",
    capabilities: ["task-management", "chat", "notes", "a2a-protocol"],
    agents: Object.keys(claudeMdConfigs),
    endpoints: { health: "/health", agents: "/api/identity/agents", tasks: "/api/tasks", chat: "/api/chat" }
  });
});


app.get("/api/identity/card/:agent", (req, res) => {
  const agentId = req.params.agent.toUpperCase();
  const identity = agentIdentities[agentId] || {};
  const claudeMd = claudeMdConfigs[agentId] || "";
  
  res.json({
    name: agentId,
    description: identity.description || identity.role || "AI Agent",
    identifier: agentId,
    version: "1.0.0",
    capabilities: identity.capabilities || [],
    role: identity.role || "worker",
    machine: identity.machine_id || "unknown",
    status: identity.last_login ? "registered" : "unregistered",
    endpoints: { chat: "/api/chat", tasks: "/api/tasks", a2a: "/api/a2a/send" },
    claude_md_preview: claudeMd.substring(0, 200),
    registered_at: identity.created_at || null,
    last_seen: identity.last_login || null
  });
});

app.put("/api/identity/card/:agent", (req, res) => {
  const agentId = req.params.agent.toUpperCase();
  const { description, capabilities } = req.body;
  if (agentIdentities[agentId]) {
    if (description) agentIdentities[agentId].description = description;
    if (capabilities) agentIdentities[agentId].capabilities = capabilities;
  }
  res.json({ success: true, agent: agentId });
});

app.get("/api/identity/:agent_id", (req, res) => {
  const agent_id = req.params.agent_id;
  const identity = agentIdentities[agent_id];
  if (!identity) return res.status(404).json({ error: "Agent not found" });
  res.json({ agent_id, ...identity });
});


function buildGraph() {
  const nodes = new Map();
  const edges = [];

  const node = (id, type, label, extra = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label, ...extra });
    return id;
  };
  const edge = (from, to, kind) => {
    if (!from || !to) return;
    edges.push({ from, to, kind });
  };

  for (const agent of agents) {
    const agentId = `agent:${agent.name}`;
    node(agentId, 'agent', agent.name, { status: agent.status });

    if (agent.location) {
      const machineId = `machine:${agent.location}`;
      node(machineId, 'machine', agent.location);
      edge(agentId, machineId, 'runs_on');
    }
  }

  for (const task of tasks) {
    if (task.created_by) {
      const id = `agent:${task.created_by}`;
      if (!nodes.has(id)) {
        node(id, 'agent', task.created_by, { unknown: true });
      }
    }
    if (task.assigned_to) {
      const id = `agent:${task.assigned_to}`;
      if (!nodes.has(id)) node(id, 'agent', task.assigned_to, { unknown: true });
    }
    if (task.created_by && task.assigned_to && task.created_by !== task.assigned_to) {
      edge(`agent:${task.created_by}`, `agent:${task.assigned_to}`, 'assigns');
    }
  }

  const coreId = node('service:consciousness-server', 'service', 'consciousness-server', { port: PORT });
  for (const ch of WS_CHANNELS) {
    const chId = node(`channel:${ch}`, 'channel', ch, {
      buffered: eventBuffer.filter(e => e.channel === ch).length
    });
    edge(coreId, chId, 'emits');
  }
  wsClients.forEach(info => {
    const clientId = node(`client:${info.agent}`, 'client', info.agent);
    for (const ch of WS_CHANNELS) {
      if (info.channels.has(ch) || info.channels.has('*')) {
        edge(clientId, `channel:${ch}`, 'subscribes');
      }
    }
  });

  const groups = new Map();
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    if (!layer.route || !layer.route.path) continue;
    const parts = String(layer.route.path).split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts.length < 2) continue;
    const group = parts[1];
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  for (const [group, count] of groups) {
    const gId = node(`routes:${group}`, 'routes', `/api/${group}`, { count });
    edge(coreId, gId, 'serves');
  }

  return { nodes: Array.from(nodes.values()), edges };
}

app.get("/api/graph", (req, res) => {
  const g = buildGraph();
  res.json({
    ...g,
    total_nodes: g.nodes.length,
    total_edges: g.edges.length,
    unknown_nodes: g.nodes.filter(n => n.unknown).length
  });
});

app.get("/api/graph/nodes", (req, res) => {
  const g = buildGraph();
  res.json({ nodes: g.nodes, total: g.nodes.length });
});

app.get("/api/graph/edges", (req, res) => {
  const g = buildGraph();
  res.json({ edges: g.edges, total: g.edges.length });
});

app.get("/api/graph/export.csv", (req, res) => {
  const which = req.query.what === 'edges' ? 'edges' : 'nodes';
  const g = buildGraph();

  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  let csv;
  if (which === 'edges') {
    csv = 'Source,Target,Type,Label\n' +
      g.edges.map(e => [e.from, e.to, 'Directed', e.kind].map(escape).join(',')).join('\n');
  } else {
    csv = 'Id,Label,Type,Unknown\n' +
      g.nodes.map(n => [n.id, n.label, n.type, n.unknown ? 'true' : 'false'].map(escape).join(',')).join('\n');
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="graph-${which}.csv"`);
  res.send(csv);
});

app.get("/api/_routes", (req, res) => {
  const stack = (app._router && app._router.stack) || [];
  const byPath = new Map();

  for (const layer of stack) {
    if (!layer.route || !layer.route.path) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    const methods = Object.keys(layer.route.methods || {})
      .filter(m => layer.route.methods[m])
      .map(m => m.toUpperCase());

    for (const p of paths) {
      if (!byPath.has(p)) byPath.set(p, new Set());
      methods.forEach(m => byPath.get(p).add(m));
    }
  }

  const routes = Array.from(byPath.entries())
    .map(([path, methods]) => ({
      path,
      methods: Array.from(methods).sort(),
      parameterised: path.includes(':')
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  res.json({
    service: 'consciousness-server',
    version: require('./package.json').version,
    generated_from: 'express router stack',
    total: routes.length,
    parameterised: routes.filter(r => r.parameterised).length,
    routes
  });
});

app.get("/api/events/recent", (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const limit = Math.min(parseInt(req.query.limit || '100', 10), EVENT_BUFFER_SIZE);
  const channel = req.query.channel;

  if (!Number.isInteger(since) || since < 0) {
    return res.status(400).json({ error: 'since must be a non-negative integer' });
  }
  if (channel && !WS_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `unknown channel: ${channel}`, available: WS_CHANNELS });
  }

  let events = eventsSince(since);
  if (channel) events = events.filter(e => e.channel === channel);

  const gapped = eventBuffer.length > 0 && since > 0 && since < eventBuffer[0].seq - 1;

  res.json({
    events: events.slice(-limit),
    total: events.length,
    latest_seq: eventSeq,
    buffer_start: eventBuffer.length ? eventBuffer[0].seq : 0,
    buffer_size: eventBuffer.length,
    buffer_capacity: EVENT_BUFFER_SIZE,
    gapped
  });
});

app.post("/api/events", (req, res) => {
  const { channel, type, data } = req.body || {};

  if (!channel || !type) {
    return res.status(400).json({ error: 'channel and type are required' });
  }
  if (!WS_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: `unknown channel: ${channel}`, available: WS_CHANNELS });
  }
  if (typeof type !== 'string' || type.length > 64) {
    return res.status(400).json({ error: 'type must be a string of at most 64 characters' });
  }
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return res.status(400).json({ error: 'data must be an object' });
  }

  const payload = data || {};
  const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size > 16384) {
    return res.status(413).json({ error: 'data too large', max_bytes: 16384, got_bytes: size });
  }

  const event = emit(channel, type, payload);
  res.status(201).json({ seq: event.seq, timestamp: event.timestamp });
});

app.get("/api/events/stats", (req, res) => {
  const byChannel = {};
  const byType = {};
  for (const ch of WS_CHANNELS) byChannel[ch] = 0;
  for (const e of eventBuffer) {
    byChannel[e.channel] = (byChannel[e.channel] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  const subscribers = {};
  for (const ch of WS_CHANNELS) subscribers[ch] = 0;
  wsClients.forEach(info => {
    for (const ch of WS_CHANNELS) {
      if (info.channels.has(ch) || info.channels.has('*')) subscribers[ch] += 1;
    }
  });

  res.json({
    channels: WS_CHANNELS,
    buffered_by_channel: byChannel,
    buffered_by_type: byType,
    subscribers_by_channel: subscribers,
    ws_clients: wsClients.size,
    total_emitted: eventSeq,
    buffer_size: eventBuffer.length,
    buffer_capacity: EVENT_BUFFER_SIZE
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    message: 'Endpoint does not exist. Check /health for server status.'
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});



const WS_CHANNELS = ['chat', 'notes', 'tasks', 'system', 'agents', 'logs', 'machines'];

const wsClients = new Map();

function broadcastToChannel(channel, data, exceptWs = null) {
  const msg = JSON.stringify({
    channel: channel,
    ...data
  });

  let sent = 0;
  wsClients.forEach((info, ws) => {
    if (ws !== exceptWs && ws.readyState === 1) {
      if (info.channels.has(channel) || info.channels.has('*')) {
        ws.send(msg);
        sent++;
      }
    }
  });

  if (sent > 0) {
    console.log(`[WS] Broadcast to '${channel}': ${sent} client(s)`);
  }
}

const EVENT_BUFFER_SIZE = parseInt(process.env.EVENT_BUFFER_SIZE || '500', 10);
const eventBuffer = [];
let eventSeq = 0;

function emit(channel, type, data, exceptWs = null) {
  eventSeq += 1;
  const event = {
    seq: eventSeq,
    channel,
    type,
    data,
    timestamp: getCurrentTimestamp()
  };

  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }

  broadcastToChannel(channel, { type, data }, exceptWs);

  redisClient.publish(`cs:${channel}`, JSON.stringify({ type, data }))
    .catch(err => console.error(`Redis publish error on cs:${channel}:`, err));

  return event;
}

function eventsSince(since = 0) {
  return eventBuffer.filter(e => e.seq > since);
}

function broadcastToWs(data, exceptWs = null) {
  let channel = 'system';
  if (data.type && data.type.includes('chat')) channel = 'chat';
  else if (data.type && data.type.includes('note')) channel = 'notes';
  else if (data.type && data.type.includes('task')) channel = 'tasks';
  else if (data.type && data.type.includes('agent')) channel = 'agents';

  broadcastToChannel(channel, data, exceptWs);
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    const agent = req.url.replace("/", "") || "Dashboard";

    wsClients.set(ws, {
      agent,
      connected_at: getCurrentTimestamp(),
      channels: new Set(['*'])
    });
    console.log(`[WS] ${agent} connected (${wsClients.size} total clients)`);

    ws.send(JSON.stringify({
      type: "connected",
      agent,
      message: "Connected to Consciousness Server",
      available_channels: WS_CHANNELS,
      subscribed: ['*'],
      latest_seq: eventSeq,
      buffer_start: eventBuffer.length ? eventBuffer[0].seq : 0
    }));

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        await handleWsMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      const info = wsClients.get(ws);
      wsClients.delete(ws);
      console.log(`[WS] ${info ? info.agent : "unknown"} disconnected`);
    });

    ws.on("error", (err) => {
      const info = wsClients.get(ws);
      console.error(`[WS] Error for ${info ? info.agent : 'unknown'}:`, err.message);
    });
  });

  return wss;
}

async function handleWsMessage(ws, msg) {
  const clientInfo = wsClients.get(ws);
  const agent = clientInfo ? clientInfo.agent : "unknown";

  const intent = msg.action || (['subscribe', 'unsubscribe'].includes(msg.type) ? msg.type : null);

  if (intent === 'subscribe') {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels || msg.channel];
    const accepted = [];
    const rejected = [];
    channels.forEach(ch => {
      if (WS_CHANNELS.includes(ch) || ch === '*') {
        clientInfo.channels.add(ch);
        accepted.push(ch);
      } else if (ch) {
        rejected.push(ch);
      }
    });
    ws.send(JSON.stringify({
      type: 'subscribed',
      channels: Array.from(clientInfo.channels),
      accepted,
      rejected,
      available_channels: WS_CHANNELS,
      latest_seq: eventSeq
    }));
    console.log(`[WS] ${agent} subscribed to: ${accepted.join(', ') || '(nothing new)'}${rejected.length ? ` — refused: ${rejected.join(', ')}` : ''}`);
    return;
  }

  if (intent === 'unsubscribe') {
    const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels || msg.channel];
    channels.forEach(ch => clientInfo.channels.delete(ch));
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels: Array.from(clientInfo.channels)
    }));
    console.log(`[WS] ${agent} unsubscribed from: ${channels.join(', ')}`);
    return;
  }

  if (msg.type === "chat") {
    const chatMsg = {
      id: uuidv4(),
      from: msg.from || agent,
      content: msg.content,
      mentions: extractMentions(msg.content),
      timestamp: getCurrentTimestamp()
    };
    await saveChatMessage(chatMsg);
    chatMessages.push(chatMsg);

    emit('chat', 'chat_message', chatMsg);

  } else if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", timestamp: getCurrentTimestamp() }));
  }
}



const HOST = process.env.CONSCIOUSNESS_HOST || '0.0.0.0';

const { attachToServer } = require('./middleware/verify-signed');
const server = http.createServer(attachToServer(null, app));
const wss = setupWebSocket(server);



function publishToAgentChannel(agentName, message) {
  const channel = `agent:${agentName.toUpperCase()}`;
  redisClient.publish(channel, JSON.stringify(message))
    .then(() => console.log(`[AGENT-BUS] Published to ${channel}`))
    .catch(err => console.error(`[AGENT-BUS] Error:`, err));
}

function notifyMentionedAgents(chatMessage) {
  if (!chatMessage.mentions || chatMessage.mentions.length === 0) return;
  chatMessage.mentions.forEach(agent => {
    if (agent.toUpperCase() === "ALL") {
      agents.forEach(a => publishToAgentChannel(a.name, chatMessage));
    } else {
      publishToAgentChannel(agent, chatMessage);
    }
  });
}

server.listen(PORT, HOST, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         CONSCIOUSNESS SERVER (Memory Server)               ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Port:        ${PORT}                                        ║`);
  console.log('║  Mode:        MVP (in-memory)                              ║');
  console.log(`║  Listening:   ${HOST}                                  ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                                ║');
  console.log('║    GET  /health                                            ║');
  console.log('║    POST /api/agents/register                               ║');
  console.log('║    GET  /api/agents                                        ║');
  console.log('║    POST /api/tasks/create                                  ║');
  console.log('║    PATCH /api/tasks/:id/status                             ║');
  console.log('║    GET  /api/chat                                          ║');
  console.log('║    POST /api/chat                                          ║');
  console.log('║    GET  /api/system/tree                                   ║');
  console.log('║    GET  /api/system/services                               ║');
  console.log('║    POST /api/system/services/:name/:action                 ║');
  console.log('║    GET  /api/system/services/:name/logs                    ║');
  console.log('║    GET  /api/system/ports                                  ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Status: READY ✅                                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Test with: curl http://localhost:${PORT}/health`);
  console.log('');
});


function startSystemMonitoring() {
  setInterval(async () => {
    try {
      agents.forEach(agent => {
        const tokensUsed = agent.context?.tokens_used || 0;
        const tokensLimit = agent.context?.tokens_limit || 200000;
        const usagePercent = Math.round((tokensUsed / tokensLimit) * 100);

        if (usagePercent >= 85) {
          emit('system', 'context_warning', {
            agent: agent.name,
            tokens_used: tokensUsed,
            tokens_limit: tokensLimit,
            usage_percent: usagePercent,
            level: usagePercent >= 95 ? 'critical' : 'warning',
            timestamp: new Date().toISOString()
          });
        }
      });

      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      const { stdout: diskInfo } = await execAsync('df -h / | tail -1');
      const diskParts = diskInfo.split(/\s+/);
      const diskUsage = parseInt(diskParts[4]);

      if (diskUsage >= 80) {
        emit('system', 'disk_warning', {
          usage_percent: diskUsage,
          mount: '/',
          level: diskUsage >= 90 ? 'critical' : 'warning',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('[MONITORING] Error:', error.message);
    }
  }, 30000);

  console.log('[MONITORING] System monitoring started (30s interval)');
}

setTimeout(startSystemMonitoring, 5000);

process.on('SIGINT', () => {
  console.log('\n\nShutting down Consciousness Server...');
  noteEmbeddingOutbox.stop();
  chatArchive.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down Consciousness Server...');
  noteEmbeddingOutbox.stop();
  chatArchive.stop();
  process.exit(0);
});
