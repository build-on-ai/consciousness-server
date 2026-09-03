#!/usr/bin/env python3
"""Machine and service status for the ecosystem."""

import os
import json
import glob
import subprocess
import psutil
import yaml
from flask import Flask, jsonify, request
from datetime import datetime

from middleware.verify_signed import flask_middleware
from middleware.ports import own_port, get_port
from middleware.sign_outbound import sign_headers, assert_usable as assert_signing_key_usable

app = Flask(__name__)
flask_middleware(app)

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_BASE_DIR)

CS_URL = os.getenv('CS_URL', f"http://localhost:{get_port('consciousness-server', 3032)}")
PORT = own_port('machines-server', 3038)
MACHINES_CONFIG_DIR = os.getenv('MACHINES_DIR', './machines')

def get_gpu_info():
    """GPU state from nvidia-smi.

    Returns {name, utilization_percent, memory_used_mb, memory_total_mb,
    temperature_c}, or None when there is no NVIDIA GPU.
    """
    try:
        result = subprocess.run([
            'nvidia-smi',
            '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
            '--format=csv,noheader,nounits'
        ], capture_output=True, text=True, timeout=5)

        if result.returncode == 0:
            parts = result.stdout.strip().split(', ')
            return {
                'name': parts[0],
                'utilization_percent': int(parts[1]),
                'memory_used_mb': int(parts[2]),
                'memory_total_mb': int(parts[3]),
                'temperature_c': int(parts[4]) if len(parts) > 4 else None
            }
    except Exception as e:
        pass
    return None

def get_system_info():
    """Current resource usage.

    Returns {cpu, memory, disk, gpu}.
    """
    cpu_percent = psutil.cpu_percent(interval=0.5)
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')

    return {
        'hostname': os.uname().nodename,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'cpu': {
            'percent': cpu_percent,
            'cores': psutil.cpu_count(),
            'load_avg': list(os.getloadavg()) if hasattr(os, 'getloadavg') else None
        },
        'memory': {
            'total_gb': round(memory.total / (1024**3), 1),
            'used_gb': round(memory.used / (1024**3), 1),
            'available_gb': round(memory.available / (1024**3), 1),
            'percent': memory.percent
        },
        'disk': {
            'total_gb': round(disk.total / (1024**3), 1),
            'used_gb': round(disk.used / (1024**3), 1),
            'free_gb': round(disk.free / (1024**3), 1),
            'percent': round(disk.percent, 1)
        },
        'gpu': get_gpu_info()
    }

def load_machine_configs():
    """Loads one machine definition per YAML file in MACHINES_DIR."""
    machines = []
    config_pattern = os.path.join(MACHINES_CONFIG_DIR, '*.yaml')

    for filepath in glob.glob(config_pattern):
        try:
            with open(filepath, 'r') as f:
                config = yaml.safe_load(f)
                if config:
                    config['_config_file'] = os.path.basename(filepath)
                    machines.append(config)
        except Exception as e:
            print(f"Error loading {filepath}: {e}")

    return machines

@app.route('/health', methods=['GET'])
def health():
    """Simple health check endpoint."""
    return jsonify({
        'status': 'ok',
        'service': 'machines-server',
        'version': '2.0.0'
    })

@app.route('/api/system', methods=['GET'])
def system_info():
    """Resource usage of the machine this block runs on."""
    return jsonify(get_system_info())

@app.route('/api/machines', methods=['GET'])
def machines_config():
    """Machine definitions read from MACHINES_DIR/*.yaml."""
    machines = load_machine_configs()
    return jsonify({
        'machines': machines,
        'total': len(machines),
        'config_dir': MACHINES_CONFIG_DIR
    })

@app.route('/api/infrastructure', methods=['GET'])
def infrastructure():
    """Local resource usage, machine definitions and core data in one answer."""
    machine_configs = load_machine_configs()

    errors = {}

    try:
        cs_machines = _get_from_core('/api/machines')
    except Exception as err:
        cs_machines = {'machines': []}
        errors['machines'] = str(err)

    try:
        services = {'services': get_services_with_status()}
    except Exception as err:
        services = {'services': []}
        errors['services'] = str(err)

    try:
        agents = _get_from_core('/api/agents')
    except Exception as err:
        agents = {'agents': []}
        errors['agents'] = str(err)

    return jsonify({
        'local_system': get_system_info(),
        'machine_configs': machine_configs,
        'runtime_machines': cs_machines.get('machines', []),
        'services': services.get('services', []),
        'agents': agents.get('agents', []),
        'errors': errors,
        'summary': {
            'total_configured_machines': len(machine_configs),
            'total_runtime_machines': len(cs_machines.get('machines', [])),
            'online_agents': len([a for a in agents.get('agents', []) if a.get('status') == 'ONLINE']),
            'gpu_available': get_gpu_info() is not None
        }
    })

@app.route('/mcp/tools', methods=['GET'])
def mcp_tools():
    """MCP tool definitions; invoke them through /mcp/call."""
    return jsonify({
        'tools': [
            {
                'name': 'get_system_resources',
                'description': 'Get current CPU, RAM, Disk, GPU usage on this machine',
                'inputSchema': {'type': 'object', 'properties': {}}
            },
            {
                'name': 'get_infrastructure',
                'description': 'Get full infrastructure overview - machines, services, agents',
                'inputSchema': {'type': 'object', 'properties': {}}
            },
            {
                'name': 'list_machines',
                'description': 'List all machines defined in the ecosystem',
                'inputSchema': {'type': 'object', 'properties': {}}
            }
        ]
    })

@app.route('/mcp/call', methods=['POST'])
def mcp_call():
    """Executes one MCP tool; body is {"tool": <name>, "args": {...}}."""
    data = request.json
    tool = data.get('tool')

    if tool == 'get_system_resources':
        return jsonify({'result': get_system_info()})
    elif tool == 'get_infrastructure':
        return infrastructure()
    elif tool == 'list_machines':
        return machines_config()
    else:
        return jsonify({'error': f'Unknown tool: {tool}'}), 400

import socket
import http.client
import json as _json

# The artefact bin/sync-ports builds from services.json and ports.yaml. Reading
# the generated file rather than the source means this block and the core see
# the same ports through their standard libraries, with no YAML parser of their
# own to disagree about.
SERVICES_RESOLVED = os.getenv(
    'SERVICES_RESOLVED', os.path.join(_ROOT_DIR, 'deploy', 'services.resolved.json'))

def load_services_config():
    """Load the resolved service registry. Raises when it is missing.

    An unreadable registry used to return an empty list silently. An empty list
    is indistinguishable from a healthy stack with nothing in it, so the failure
    has no symptom to notice.
    """
    with open(SERVICES_RESOLVED, 'r') as f:
        config = _json.load(f)
    services = config.get('services')
    if not isinstance(services, list):
        raise ValueError(f"{SERVICES_RESOLVED}: expected a 'services' array")
    for svc in services:
        if not isinstance(svc.get('port'), int):
            raise ValueError(
                f"{SERVICES_RESOLVED}: service {svc.get('name')!r} has no resolved port")
    return services

def _get_from_core(path, timeout=5):
    """The only path from this block to the core, so no call site can forget to sign.

    Raises on transport failure or non-2xx; the caller decides what silence means.
    """
    import requests
    headers = sign_headers('GET', path)
    resp = requests.get(f'{CS_URL}{path}', headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def check_service_status(service):
    """Check if a service is responding.

    Every service is reached the same way: through the host gateway, at the
    port ports.yaml publishes. One frame of reference means a block running
    with network_mode: host needs no special case, and no entry can name a
    port belonging to a different address space — which is how the checker
    asked semantic-search about 3037 while it answered on 13037.

    SERVICES_HOST overrides the gateway for running this checker on the host
    itself. Hardcoding localhost here meant the checker inside a container
    probed *itself* for every entry and reported one service alive out of
    eight — the containers were fine, the question was wrong.

    A service with `path: null` does not speak HTTP. Probing it with a GET
    can only ever look like death, so those get a plain TCP connect.
    """
    host = os.environ.get('SERVICES_HOST') or 'host.docker.internal'
    path = service.get('path')

    if not path:
        try:
            with socket.create_connection((host, service['port']), timeout=2):
                return 'active'
        except OSError:
            return 'inactive'

    try:
        conn = http.client.HTTPConnection(host, service['port'], timeout=2)
        conn.request('GET', path)
        response = conn.getresponse()
        body = response.read(8192)
        conn.close()
        # Accept 200-499 as "active" (including WebSocket upgrades, redirects, etc.)
        if response.status >= 500:
            return 'inactive'
        return ('active', body)
    except Exception:
        return 'inactive'


def _dependencies_from(body):
    """Pull a block's own dependency report out of its /health answer.

    semantic-search runs with network_mode: host and is the only block that can
    see an Ollama bound to 127.0.0.1. It reports that in its /health, and this
    is where the report is picked up — so nothing here has to reach a service
    that is deliberately not on the network.
    """
    if not body:
        return None
    try:
        payload = _json.loads(body)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    deps = {}
    for name in ('ollama',):
        if name in payload:
            deps[name] = payload[name]
    return deps or None

def get_services_with_status():
    """Load services from config and check their status dynamically."""
    services = load_services_config()
    result = {}
    for svc in services:
        probed = check_service_status(svc)
        if isinstance(probed, tuple):
            status, body = probed
        else:
            status, body = probed, None
        entry = {
            'port': svc['port'],
            'path': svc.get('path', '/health'),
            'description': svc.get('description', ''),
            'status': status
        }
        # A block's own dependencies travel with it rather than as separate
        # rows: Ollama is not a service of this stack and probing it from a
        # container could only ever fail, however healthy it is on the host.
        deps = _dependencies_from(body)
        if deps:
            entry['dependencies'] = deps
        result[svc['name']] = entry
    return result

@app.route('/', methods=['GET'])
def index():
    """Root endpoint."""
    return jsonify({
        'service': 'machines-server',
        'version': '1.0.0',
        'endpoints': ['/', '/health', '/api/system', '/api/machines', '/api/infrastructure', '/api/services']
    })

@app.route('/api/services', methods=['GET'])
def services_endpoint():
    """Get all services with dynamically checked status."""
    return jsonify({
        'services': get_services_with_status(),
        'checked_at': datetime.now().isoformat()
    })

if __name__ == '__main__':
    assert_signing_key_usable()

    from middleware.sign_outbound import agent_id, is_configured
    signing = f"as {agent_id()}" if is_configured() else "OFF (CS_SIGNING_KEY unset)"

    print("=" * 60)
    print("Machines Server v2.0")
    print("=" * 60)
    print(f"  Port:        {PORT}")
    print(f"  CS URL:      {CS_URL}")
    print(f"  Machines:    {MACHINES_CONFIG_DIR}")
    print(f"  Signing:     {signing}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=PORT)
