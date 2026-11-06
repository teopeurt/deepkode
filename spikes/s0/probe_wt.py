import json, subprocess, sys
from app_server.blocking_client import BlockingServiceClient
from app_server.service_state import ServiceFiles
from core.persistence.database import default_database_path
rpc = BlockingServiceClient(ServiceFiles(default_database_path()))
def call(m, p):
    try: return rpc.call(m, p)
    except Exception as e: return {"__error__": f"{type(e).__name__}: {e}"}
path = sys.argv[1]
proj = call("project/add", {"path": path, "trustState": "trusted"})["project"]
th = call("thread/start", {"projectId": proj["id"], "title": "wt", "connectionId": "mock", "model": "mock-1"})["thread"]
wt = call("git/worktree/create", {"threadId": th["id"]})
print("worktree/create:", json.dumps(wt, default=str)[:500])
th2 = call("thread/read", {"threadId": th["id"]}).get("thread", {})
print("thread.workspacePath:", th2.get("workspacePath"), "| worktreePath:", th2.get("worktreePath"))
turn = call("turn/start", {"threadId": th["id"], "prompt": "MARK:WRITE from-wt.txt create", "messageId": "wt-1", "skills": [], "connectionId": "mock", "model": "mock-1"})
print("turn/start:", turn.get("__error__") or turn["turn"]["status"])
import time; time.sleep(4)
turn_id = turn.get("turn", {}).get("id")
print("turn:", call("turn/read", {"turnId": turn_id}).get("turn", {}).get("status"))
print("projects:", len(call("project/list", {}).get("projects", [])))
rm = call("git/worktree/remove", {"threadId": th["id"], "disposition": "keep"})
print("worktree/remove keep:", json.dumps(rm, default=str)[:300])
rpc.close()
