import { Job, UnrecoverableError } from 'bullmq'
import { QueueService } from '#services/queue_service'
import { createHash } from 'crypto'
import Docker from 'dockerode'
import logger from '@adonisjs/core/services/logger'
import { KiwixLibraryService } from '#services/kiwix_library_service'

export interface YoutubeZimJobParams {
  url: string
}

export interface YoutubeZimProgressData {
  percent: number
  message: string
  lastProgressTime: number
}

export class YoutubeZimJob {
  static get queue() {
    return 'youtube-zim'
  }

  static get key() {
    return 'youtube-zim'
  }

  /** In-memory registry of active container IDs for cancellation */
  static activeContainers: Map<string, string> = new Map()

  static getJobId(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 16)
  }

  private getDocker(): Docker {
    const isWindows = process.platform === 'win32'
    return isWindows
      ? new Docker({ socketPath: '//./pipe/docker_engine' })
      : new Docker({ socketPath: '/var/run/docker.sock' })
  }

  async handle(job: Job) {
    const { url } = job.data as YoutubeZimJobParams
    const docker = this.getDocker()

    const storagePath = process.env.NOMAD_STORAGE_PATH
    if (!storagePath) {
      throw new UnrecoverableError('NOMAD_STORAGE_PATH environment variable is not set')
    }

    const rawHostPath = `${storagePath}/youtube-raw`
    const zimHostPath = `${storagePath}/zim`
    const image = 'ghcr.io/flynnty/project-nomad-youtube-builder:latest'

    const updateProgress = async (percent: number, message: string) => {
      const data: YoutubeZimProgressData = { percent, message, lastProgressTime: Date.now() }
      await job.updateProgress(data).catch((err) => {
        if (err?.code !== -1) throw err
      })
    }

    await updateProgress(0, 'Pulling youtube-builder image...')
    logger.info(`[YoutubeZimJob] Pulling image ${image}`)

    try {
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err)
          docker.modem.followProgress(stream, (pullErr: Error | null) => {
            if (pullErr) return reject(pullErr)
            resolve()
          })
        })
      })
    } catch (pullErr: any) {
      logger.warn(`[YoutubeZimJob] Image pull failed (may be offline), attempting with cached image: ${pullErr.message}`)
    }

    await updateProgress(2, 'Starting youtube-builder container...')
    logger.info(`[YoutubeZimJob] Creating container for URL: ${url}`)

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['--url', url, '--raw-dir', '/raw', '--zim-dir', '/zim', '--quality', '480'],
      HostConfig: {
        Binds: [`${rawHostPath}:/raw`, `${zimHostPath}:/zim`],
        AutoRemove: false,
        NetworkMode: 'bridge', // needs internet to download from YouTube
      },
    })

    const containerId = container.id
    YoutubeZimJob.activeContainers.set(job.id!, containerId)

    try {
      await container.start()
      logger.info(`[YoutubeZimJob] Container started: ${containerId.slice(0, 12)}`)

      // Attach to container output and parse NOMAD_PROGRESS lines
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: false,
      })

      const progressParser = new Promise<void>((resolve) => {
        let buffer = ''

        const onData = async (chunk: Buffer) => {
          // Docker multiplexed stream: first 8 bytes are header, rest is data
          // We strip the 8-byte header from each frame
          let offset = 0
          while (offset < chunk.length) {
            if (chunk.length - offset < 8) break
            const size = chunk.readUInt32BE(offset + 4)
            const payload = chunk.slice(offset + 8, offset + 8 + size).toString('utf8')
            offset += 8 + size
            buffer += payload

            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (trimmed.startsWith('NOMAD_PROGRESS:')) {
                const parts = trimmed.slice('NOMAD_PROGRESS:'.length).split(':')
                const pct = Math.min(99, parseInt(parts[0], 10) || 0)
                const msg = parts.slice(1).join(':')
                logger.info(`[YoutubeZimJob] Progress ${pct}%: ${msg}`)
                await updateProgress(pct, msg).catch(() => {})
              } else if (trimmed.startsWith('NOMAD_DONE:')) {
                logger.info(`[YoutubeZimJob] Done: ${trimmed}`)
              } else if (trimmed.startsWith('NOMAD_ERROR:')) {
                logger.error(`[YoutubeZimJob] Error from builder: ${trimmed}`)
              } else if (trimmed) {
                logger.debug(`[YoutubeZimJob] Builder: ${trimmed}`)
              }
            }
          }
        }

        ;(logStream as any).on('data', onData)
        ;(logStream as any).on('end', () => resolve())
        ;(logStream as any).on('error', () => resolve())
      })

      await progressParser

      // Wait for container to finish and get exit code
      const result = await container.wait()
      const exitCode = result.StatusCode

      logger.info(`[YoutubeZimJob] Container exited with code ${exitCode}`)

      if (exitCode !== 0) {
        throw new Error(`youtube-builder exited with code ${exitCode}`)
      }

      // Rebuild Kiwix library so the new ZIM appears immediately
      await updateProgress(99, 'Updating Kiwix library...')
      const kiwixLibrary = new KiwixLibraryService()
      await kiwixLibrary.rebuildFromDisk()

      await updateProgress(100, 'Complete!')
      logger.info(`[YoutubeZimJob] Successfully created YouTube ZIM for ${url}`)

    } finally {
      YoutubeZimJob.activeContainers.delete(job.id!)
      // Clean up container (handles both success and failure)
      try {
        await container.remove({ force: true })
      } catch {
        // Container may already be removed
      }
    }
  }

  /**
   * Cancel an active YouTube ZIM job by stopping its container.
   * The container exit will cause the job to fail (non-zero exit code),
   * which BullMQ will treat as a normal failure.
   */
  static async signalCancel(jobId: string): Promise<void> {
    const containerId = YoutubeZimJob.activeContainers.get(jobId)
    if (!containerId) return

    const isWindows = process.platform === 'win32'
    const docker = isWindows
      ? new Docker({ socketPath: '//./pipe/docker_engine' })
      : new Docker({ socketPath: '/var/run/docker.sock' })

    try {
      const container = docker.getContainer(containerId)
      await container.stop({ t: 5 })
    } catch {
      // Container may have already exited
    }
  }

  /**
   * Rebuild the unified youtube_library.zim without downloading anything.
   * Used after deleting a channel or video from raw storage.
   */
  static async rebuildLibrary(storagePath: string): Promise<void> {
    const rawHostPath = `${storagePath}/youtube-raw`
    const zimHostPath = `${storagePath}/zim`
    const image = 'ghcr.io/flynnty/project-nomad-youtube-builder:latest'

    const isWindows = process.platform === 'win32'
    const docker = isWindows
      ? new Docker({ socketPath: '//./pipe/docker_engine' })
      : new Docker({ socketPath: '/var/run/docker.sock' })

    logger.info('[YoutubeZimJob] Rebuilding youtube_library.zim from raw storage...')

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['--rebuild-only', '--raw-dir', '/raw', '--zim-dir', '/zim'],
      HostConfig: {
        Binds: [`${rawHostPath}:/raw`, `${zimHostPath}:/zim`],
        AutoRemove: false,
        NetworkMode: 'none', // no internet needed for rebuild
      },
    })

    try {
      await container.start()
      const result = await container.wait()
      if (result.StatusCode !== 0) {
        logger.warn(`[YoutubeZimJob] rebuildLibrary exited with code ${result.StatusCode}`)
      } else {
        logger.info('[YoutubeZimJob] rebuildLibrary complete')
      }
    } finally {
      try { await container.remove({ force: true }) } catch { /* already gone */ }
    }
  }

  static async dispatch(params: YoutubeZimJobParams) {
    const queueService = new QueueService()
    const queue = queueService.getQueue(this.queue)
    const jobId = this.getJobId(params.url)

    try {
      const job = await queue.add(this.key, params, {
        jobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
      })
      return { job, created: true, message: `Dispatched YouTube ZIM job for ${params.url}` }
    } catch (error: any) {
      if (error.message.includes('job already exists')) {
        const existing = await queue.getJob(jobId)
        return { job: existing, created: false, message: `Job already exists for ${params.url}` }
      }
      throw error
    }
  }

  static async getActiveByUrl(url: string): Promise<Job | undefined> {
    const queueService = new QueueService()
    const queue = queueService.getQueue(this.queue)
    const jobId = this.getJobId(url)
    const job = await queue.getJob(jobId)
    if (!job) return undefined

    const state = await job.getState()
    if (state === 'active' || state === 'waiting' || state === 'delayed') return job

    try { await job.remove() } catch { /* already gone */ }
    return undefined
  }

  static async listJobs() {
    const queueService = new QueueService()
    const queue = queueService.getQueue(this.queue)
    const [waiting, active, delayed, failed] = await Promise.all([
      queue.getJobs(['waiting']),
      queue.getJobs(['active']),
      queue.getJobs(['delayed']),
      queue.getJobs(['failed']),
    ])
    return { waiting, active, delayed, failed }
  }
}
