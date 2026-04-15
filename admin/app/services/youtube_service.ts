import { inject } from '@adonisjs/core'
import { join } from 'path'
import { deleteFileIfExists, ensureDirectoryExists, listDirectoryContents, ZIM_STORAGE_PATH } from '../utils/fs.js'
import { KiwixLibraryService } from './kiwix_library_service.js'
import { YoutubeZimJob, YoutubeZimProgressData } from '#jobs/youtube_zim_job'

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i

@inject()
export class YoutubeService {
  constructor(private kiwixLibraryService: KiwixLibraryService) {}

  /**
   * Validate and dispatch a YouTube ZIM build job.
   * Returns the jobId so the frontend can track progress.
   */
  async download(url: string): Promise<{ jobId: string; message: string }> {
    if (!YOUTUBE_URL_PATTERN.test(url)) {
      throw new Error('invalid_url')
    }

    const existing = await YoutubeZimJob.getActiveByUrl(url)
    if (existing) {
      return {
        jobId: existing.id!.toString(),
        message: 'A download for this URL is already in progress.',
      }
    }

    const { job } = await YoutubeZimJob.dispatch({ url })

    return {
      jobId: job!.id!.toString(),
      message: 'YouTube download started.',
    }
  }

  /**
   * List all downloaded YouTube ZIM files (those starting with "youtube_").
   */
  async list() {
    const dirPath = join(process.cwd(), ZIM_STORAGE_PATH)
    await ensureDirectoryExists(dirPath)

    const all = await listDirectoryContents(dirPath)
    const files = all.filter((item) => item.name.endsWith('.zim') && item.name.startsWith('youtube_'))

    return { files }
  }

  /**
   * Delete a YouTube ZIM file and rebuild the Kiwix library.
   */
  async delete(filename: string): Promise<void> {
    if (!filename.startsWith('youtube_') || !filename.endsWith('.zim')) {
      throw new Error('not_found')
    }

    const filePath = join(process.cwd(), ZIM_STORAGE_PATH, filename)
    const existed = await deleteFileIfExists(filePath).then(() => true).catch(() => false)

    if (!existed) {
      // Check if file was actually there before we tried to delete
      // deleteFileIfExists swallows ENOENT, so just proceed with library rebuild
    }

    await this.kiwixLibraryService.rebuildFromDisk()
  }

  /**
   * List active/pending/failed YouTube ZIM jobs for the frontend progress panel.
   */
  async listJobs() {
    const { waiting, active, delayed, failed } = await YoutubeZimJob.listJobs()

    type JobState = 'waiting' | 'active' | 'delayed' | 'failed'
    const tagged = [
      ...waiting.map((j) => ({ job: j, state: 'waiting' as JobState })),
      ...active.map((j) => ({ job: j, state: 'active' as JobState })),
      ...delayed.map((j) => ({ job: j, state: 'delayed' as JobState })),
      ...failed.map((j) => ({ job: j, state: 'failed' as JobState })),
    ]

    return tagged.map(({ job, state }) => {
      const raw = job.progress as any
      const progress: YoutubeZimProgressData | null =
        raw && typeof raw === 'object' && 'percent' in raw ? raw : null

      return {
        jobId: job.id!.toString(),
        url: (job.data as { url: string }).url,
        percent: progress?.percent ?? 0,
        message: progress?.message ?? '',
        lastProgressTime: progress?.lastProgressTime,
        status: state,
        failedReason: job.failedReason || undefined,
      }
    })
  }

  /**
   * Cancel an active YouTube ZIM job.
   */
  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    await YoutubeZimJob.signalCancel(jobId)

    const { active, waiting, delayed } = await YoutubeZimJob.listJobs()
    const job = [...active, ...waiting, ...delayed].find((j) => j.id === jobId)

    if (job) {
      try { await job.remove() } catch { /* may be locked */ }
    }

    return { success: true, message: 'Cancel signal sent.' }
  }
}
