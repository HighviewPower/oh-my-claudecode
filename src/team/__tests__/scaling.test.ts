import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

import { scaleUp } from '../scaling.js';

function killTmuxPane(paneId: string): void {
  try {
    execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'pipe' });
  } catch { /* pane may not exist */ }
}

describe('scaleUp duplicate worker guard', () => {
  let cwd: string;
  const spawnedPaneIds: string[] = [];

  afterEach(async () => {
    // Kill any tmux panes spawned by scaleUp before removing temp dir
    if (cwd) {
      try {
        const configRaw = await readFile(join(cwd, '.omc', 'state', 'team'), 'utf-8').catch(() => '');
        // Scan all team config files for pane_ids
        const { readdirSync, readFileSync } = await import('fs');
        const teamDir = join(cwd, '.omc', 'state', 'team');
        try {
          for (const team of readdirSync(teamDir)) {
            const configPath = join(teamDir, team, 'config.json');
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              for (const worker of config.workers ?? []) {
                if (worker.pane_id) spawnedPaneIds.push(worker.pane_id);
              }
            } catch { /* config may not exist */ }
          }
        } catch { /* team dir may not exist */ }
      } catch { /* best effort */ }
    }
    for (const paneId of spawnedPaneIds) {
      killTmuxPane(paneId);
    }
    spawnedPaneIds.length = 0;
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it('skips past colliding worker names when next_worker_index is stale', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-duplicate-'));
    const teamName = 'demo-team';
    const root = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session:0',
      next_task_id: 2,
      next_worker_index: 1,
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      team_state_root: root,
    }, null, 2), 'utf-8');

    const result = await scaleUp(
      teamName,
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    // scaleUp skips worker-1 (collision) and tries worker-2.
    // Tmux pane creation fails in test env, but must NOT fail with collision error.
    if (!result.ok) {
      expect(result.error).not.toContain('refusing to spawn duplicate worker identity');
    }

    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf-8')) as { workers: Array<{ name: string }>; next_worker_index?: number };
    // next_worker_index must have advanced past the collision
    expect(config.next_worker_index).toBeGreaterThan(1);
  });

  it('self-heals across multiple collisions', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-skip-'));
    const teamName = 'skip-team';
    const root = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 2,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [] },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: [] },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'skip-session:0',
      next_task_id: 2,
      next_worker_index: 1,
      leader_pane_id: '%0',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      team_state_root: root,
    }, null, 2), 'utf-8');

    await scaleUp(
      teamName,
      1,
      'claude',
      [{ subject: 'demo', description: 'demo task' }],
      cwd,
      { OMC_TEAM_SCALING_ENABLED: '1' } as NodeJS.ProcessEnv,
    );

    // next_worker_index must skip past both worker-1 and worker-2
    const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf-8')) as { next_worker_index?: number };
    expect(config.next_worker_index).toBeGreaterThan(2);
  });
});
