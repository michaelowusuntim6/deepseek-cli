#!/usr/bin/env python3
"""Switch the fork's project settings to one provider (test helper).

Usage: scripts/set_provider.py deepseek-web|openai-compatible|llamacpp
"""

import json
import pathlib
import sys

provider = sys.argv[1]
path = pathlib.Path('.gemini/settings.json')
settings = json.loads(path.read_text())
settings.setdefault('security', {}).setdefault('auth', {})
settings['security']['auth']['selectedType'] = provider
settings.setdefault('providers', {})
settings['providers']['openaiCompatible'] = {
    'baseUrl': 'http://127.0.0.1:8080/v1',
    'apiKey': 'none',
    'model': 'qwen3.5-0.8b',
    'thinking': False,
}
settings['providers']['llamacpp'] = {
    'baseUrl': 'http://127.0.0.1:8080/v1',
    'apiKey': 'none',
    'model': 'qwen3.5-0.8b',
    'thinking': False,
}
path.write_text(json.dumps(settings, indent=2) + '\n')
print(f"selectedType={provider}")
