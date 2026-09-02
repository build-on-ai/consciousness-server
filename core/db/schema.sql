
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'WORKER',
  status TEXT DEFAULT 'OFFLINE',
  current_task_id TEXT,
  context_percent INTEGER DEFAULT 0,
  last_heartbeat DATETIME,
  location TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'NORMAL',
  status TEXT DEFAULT 'PENDING',
  deadline DATETIME,
  result TEXT,
  artifacts_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  level TEXT DEFAULT 'INFO',
  message TEXT NOT NULL,
  task_id TEXT,
  metadata TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  context_percent INTEGER NOT NULL,
  task_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);


CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority, status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent);
CREATE INDEX IF NOT EXISTS idx_logs_project ON logs(project);
CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_location ON agents(location);
CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat ON agents(last_heartbeat);



CREATE VIEW IF NOT EXISTS v_active_tasks AS
SELECT
  t.*,
  (julianday('now') - julianday(t.created_at)) * 24 AS age_hours
FROM tasks t
WHERE t.status IN ('PENDING', 'IN_PROGRESS');

CREATE VIEW IF NOT EXISTS v_recent_activity AS
SELECT
  l.timestamp,
  l.agent,
  l.level,
  l.message,
  l.project,
  t.title AS task_title,
  t.status AS task_status
FROM logs l
LEFT JOIN tasks t ON l.task_id = t.id
ORDER BY l.timestamp DESC
LIMIT 100;

CREATE VIEW IF NOT EXISTS v_agent_summary AS
SELECT
  a.name,
  a.status,
  a.location,
  a.context_percent,
  t.title AS current_task_title,
  (julianday('now') - julianday(a.last_heartbeat)) * 1440 AS minutes_since_heartbeat
FROM agents a
LEFT JOIN tasks t ON a.current_task_id = t.id;
