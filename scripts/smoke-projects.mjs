// Each consumer owns only its directory beneath the fresh smoke workspace. Release its large
// runtime before starting the next consumer; retain fixtures and logs for diagnosing failures.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export async function runSmokeProjects(projects, work, runProject, { keep = false } = {}) {
  for (const [index, project] of projects.entries()) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(project.name)) throw new Error('Invalid smoke project name');
    try {
      await runProject(project, index);
    } finally {
      if (!keep) {
        for (const name of ['node_modules', 'dist', '.astro', '.wrangler']) {
          rmSync(join(work, project.name, name), { recursive: true, force: true });
        }
      }
    }
  }
}
