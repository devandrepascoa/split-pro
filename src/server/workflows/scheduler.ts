/**
 * Scheduler Workflow. Replaces pg_cron and the old in-process setTimeout loops.
 * Triggered every minute by the `schedules` on the SCHEDULER Workflow binding (wrangler.jsonc).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { env as appEnv } from '~/env';
import { checkRecurrenceNotifications } from '~/server/api/services/notificationService';
import { deleteStaleCache, firesInMinute, getDueJobs } from '~/server/api/services/scheduleService';
import { runRecurringJob } from '~/server/api/services/splitService';
import { logError } from '~/server/observability/errorLog';

const retry = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
};

export class SchedulerWorkflow extends WorkflowEntrypoint<unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const now = new Date(event.schedule?.scheduledTime ?? event.timestamp.getTime());

    const due = await step.do('load due jobs', async () =>
      (await getDueJobs(now)).map((j) => j.jobid),
    );

    // One step per job: retried independently; runRecurringJob is idempotent per run slot.
    for (const jobid of due) {
      await step.do(`run job ${jobid}`, retry, async () => {
        try {
          const result = await runRecurringJob(jobid, now);
          return { jobid, skipped: result.skipped };
        } catch (error) {
          logError('workflow', error, { step: 'run job', jobid, instanceId: event.instanceId });
          throw error;
        }
      });
    }

    if (due.length > 0) {
      await step.do('recurrence notifications', retry, async () => {
        try {
          await checkRecurrenceNotifications();
          return true;
        } catch (error) {
          logError('workflow', error, {
            step: 'recurrence notifications',
            instanceId: event.instanceId,
          });
          throw error;
        }
      });
    }

    const cleanupRule = appEnv.CLEAR_CACHE_CRON_RULE;
    const retention = appEnv.CACHE_RETENTION_INTERVAL;
    if (cleanupRule && retention && firesInMinute(cleanupRule, now)) {
      await step.do('cache cleanup', retry, async () => {
        try {
          await deleteStaleCache(retention, now);
          return true;
        } catch (error) {
          logError('workflow', error, { step: 'cache cleanup', instanceId: event.instanceId });
          throw error;
        }
      });
    }

    return { ranJobs: due.length };
  }
}
