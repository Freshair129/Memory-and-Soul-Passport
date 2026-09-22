---
version: "1.0.0b"
status: beta
created_at: "2026-09-20T16:24:00+07:00,RWANG"
last_update: "2026-09-20T16:24:00+07:00,RWANG"
---

# KI17 stale worker lock after Docker Desktop restart

## Symptom

After Docker Desktop was unavailable and then restarted, the local `genesis-worker` container entered a restart loop while web and line-worker recovered. The HTTP health endpoint was reachable, but the knowledge worker was unhealthy.

## Evidence

The Docker API named pipe `dockerDesktopLinuxEngine` was missing and no Docker Desktop process was running. After Docker Desktop recovery, the worker exited with `WORKER_STORE_ALREADY_OWNED:1` and restart count increased. The only container referencing `zuri-ai_ki17-genesis-store` was the stopped worker. Read-only volume inspection found `/var/lib/zuri-ki17/genesis/worker.lock`, created on 2026-09-19 with `pid: 1`; the lock hash was `5dc9f2c3bc846f79a35540384ae8482609e282d4faacad028d7c1f1e4a0b49ec`. After stopping the worker and removing only that lock, the worker reached `healthy` with restart count `0`; the last 30 seconds contained zero error-like lines, relay smoke passed `2/2`, and the MSP schema audit remained at migration `15/15` with foreign-key errors `0`.

## Root cause

The worker lock stores a process ID and treats a live PID as ownership. Docker restart preserved a lock created by the prior container's PID 1. The new container also has PID 1, so the worker interpreted the stale lock as an active owner and refused to start. This is PID reuse across container lifetimes, not an MSP schema or release-image regression.

## Why it escaped detection

The initial deploy verification ran while Docker was healthy and the worker lock was owned by a live process. The failure only appeared after the Docker daemon and container lifecycle were interrupted and restored.

## Prevention

After a Docker daemon restart, verify the worker lock owner before declaring the stack healthy. Keep the volume backup and inspect running containers using the volume before clearing a lock. A future worker hardening change should bind lock ownership to a container boot identity or equivalent generation marker instead of PID alone, then add a restart-recovery acceptance case.
