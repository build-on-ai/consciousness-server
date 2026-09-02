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

SERVICES_YAML = os.getenv('SERVICES_YAML', os.path.join(_ROOT_DIR, 'services.yaml'))

def load_services_config():
    """Load services to check from YAML config."""
    try:
        with open(SERVICES_YAML, 'r') as f:
            config = yaml.safe_load(f)
            return config.get('services', [])
    except Exception as e:
        print(f"[services] could not read {SERVICES_YAML}: {e}")
        return []

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
    """Checks whether a service answers.

    Host comes from SERVICES_HOST, then the entry's own `host`, then localhost;
    an entry with `path: null` speaks no HTTP and gets a plain TCP connect.
    """
    host = os.environ.get('SERVICES_HOST') or service.get('host') or 'localhost'
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
        conn.close()
        if response.status < 500:
            return 'active'
        return 'inactive'
    except Exception:
        return 'inactive'

def get_services_with_status():
    """Load services from config and check their status dynamically."""
    services = load_services_config()
    result = {}
    for svc in services:
        status = check_service_status(svc)
        result[svc['name']] = {
            'port': svc['port'],
            'path': svc.get('path', '/health'),
            'description': svc.get('description', ''),
            'status': status
        }
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
