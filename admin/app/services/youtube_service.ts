import { inject } from '@adonisjs/core'
import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { ensureDirectoryExists, ZIM_INDEX_PATH } from '../utils/fs.js'
import { KiwixLibraryService } from './kiwix_library_service.js'
import { YoutubeZimJob, YoutubeZimProgressData } from '#jobs/youtube_zim_job'

const YOUTUBE_URL_PATTERN = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i

const YOUTUBE_RAW_PATH = '/storage/youtube-raw'

async function readJsonSafe(filePath: string): Promise<Record<string, any>> {
  try {
    const text = await readFile(filePath, 'utf-8')
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

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
   * List all downloaded YouTube content from raw storage.
   */
  async list() {
    const rawPath = join(process.cwd(), YOUTUBE_RAW_PATH)
    await ensureDirectoryExists(rawPath)

    // Channels
    const channelsRoot = join(rawPath, 'channels')
    const channelIds = await listSubdirs(channelsRoot)
    const channels = await Promise.all(
      channelIds.map(async (id) => {
        const info = await readJsonSafe(join(channelsRoot, id, 'info.json'))
        const videoIds: string[] = info.videos || (await listSubdirs(join(channelsRoot, id, 'videos')))
        return {
          id,
          name: (info.name as string) || id,
          description: (info.description as string) || '',
          videoCount: videoIds.length,
        }
      })
    )

    // Standalone videos
    const videosRoot = join(rawPath, 'videos')
    const videoIds = await listSubdirs(videosRoot)
    const videos = await Promise.all(
      videoIds.map(async (id) => {
        const info = await readJsonSafe(join(videosRoot, id, 'info.json'))
        return {
          id,
          title: (info.title as string) || id,
          channel: (info.channel as string) || '',
          duration: (info.duration as string) || '',
          uploadDate: (info.upload_date as string) || '',
        }
      })
    )

    return { channels, videos }
  }

  /**
   * Delete a channel or standalone video from raw storage, then rebuild the unified ZIM.
   */
  async delete(type: 'channel' | 'video', id: string): Promise<void> {
    if (!id || !/^[\w-]+$/.test(id)) {
      throw new Error('invalid_id')
    }

    const rawPath = join(process.cwd(), YOUTUBE_RAW_PATH)
    const subDir = type === 'channel' ? 'channels' : 'videos'
    const targetPath = join(rawPath, subDir, id)

    await rm(targetPath, { recursive: true, force: true })

    // Remove the per-channel ZIM so it no longer appears in Kiwix
    if (type === 'channel') {
      const zimPath = join(process.cwd(), ZIM_INDEX_PATH, `youtube_channel_${id.toLowerCase()}.zim`)
      await rm(zimPath, { force: true })
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
