"""S0 probe: drive the DeepCode service over its own JSON-RPC client. Run with the DeepCode tool venv's python."""
import json
import sys
import time

from app_server.blocking_client import BlockingServiceClient
from app_server.service_state import ServiceFiles
from core.persistence.database import default_database_path

rpc = BlockingServiceClient(ServiceFiles(default_database_path()))


def call(method, params):
    try:
        return rpc.call(method, params)
    except Exception as exc:  # noqa: BLE001 - probe prints every failure
        return {"__error__": f"{type(exc).__name__}: {exc}"}


def short(value, n=900):
    return json.dumps(value, default=str)[:n]


cmd = sys.argv[1]

if cmd == "idempotency":
    path = sys.argv[2]
    project = call("project/add", {"path": path, "trustState": "trusted"})
    print("project/add:", short(project, 300))
    pid = project["project"]["id"]
    thread = call("thread/start", {"projectId": pid, "title": "probe", "workspacePath": path, "connectionId": "mock", "model": "mock-1"})
    print("thread/start keys:", list(thread.keys()))
    tid = thread["thread"]["id"]
    first = call("turn/start", {"threadId": tid, "prompt": "MARK:TEXT idempotency probe", "messageId": "msg-fixed-1", "skills": [], "connectionId": "mock", "model": "mock-1"})
    print("turn/start #1:", short(first, 500))
    second = call("turn/start", {"threadId": tid, "prompt": "MARK:TEXT idempotency probe", "messageId": "msg-fixed-1", "skills": [], "connectionId": "mock", "model": "mock-1"})
    print("turn/start #2 (same messageId):", short(second, 500))
    third = call("turn/start", {"threadId": tid, "prompt": "MARK:TEXT DIFFERENT PROMPT SAME ID", "messageId": "msg-fixed-1", "skills": [], "connectionId": "mock", "model": "mock-1"})
    print("turn/start #3 (same id, different prompt):", short(third, 500))
    time.sleep(2)
    listed = call("thread/read", {"threadId": tid})
    print("thread/read:", short(listed, 1200))

elif cmd == "trust":
    path = sys.argv[2]
    added = call("project/add", {"path": path, "trustState": "untrusted"})
    print("project/add untrusted:", short(added, 400))
    pid = added.get("project", {}).get("id")
    if pid:
        thread = call("thread/start", {"projectId": pid, "title": "untrusted", "workspacePath": path, "connectionId": "mock", "model": "mock-1"})
        print("thread/start on untrusted:", short(thread, 400))
        listed = call("project/list", {})
        print("project/list:", short(listed, 800))

elif cmd == "read":
    tid, turn = sys.argv[2], sys.argv[3]
    r = call("turn/read", {"turnId": turn})
    t = r.get("turn", r)
    print(json.dumps({"status": t.get("status"), "error": r.get("__error__"), "endedAt": t.get("endedAt") or t.get("completedAt")}))

elif cmd == "interrupt":
    tid, turn = sys.argv[2], sys.argv[3]
    print("interrupt:", short(call("turn/interrupt", {"threadId": tid, "turnId": turn}), 300))

elif cmd == "events":
    tid = sys.argv[2]
    r = call("event/replay", {"threadId": tid, "limit": 200})
    evs = r.get("events", [])
    print(len(evs), "events;", [e.get("msg", {}).get("type") or e.get("type") for e in evs][:40], r.get("__error__"))

elif cmd == "methods":
    print("see protocol schema")

rpc.close()
