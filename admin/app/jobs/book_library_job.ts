import { Job, UnrecoverableError } from 'bullmq'
import { QueueService } from '#services/queue_service'
import Docker from 'dockerode'
import logger from '@adonisjs/core/services/logger'
import { KiwixLibraryService } from '#services/kiwix_library_service'

export interface BookLibraryProgressData {
  percent: number
  message: string
  lastProgressTime: number
}

const JOB_ID = 'book-library-rebuild'

export class BookLibraryJob {
  static get queue() {
    return 'book-library'
  }

  static get key() {
    return 'book-library'
  }

  private getDocker(): Docker {
    const isWindows = process.platform === 'win32'
    return isWindows
      ? new Docker({ socketPath: '//./pipe/docker_engine' })
      : new Docker({ socketPath: '/var/run/docker.sock' })
  }

  async handle(job: Job) {
    const docker = this.getDocker()

    const storagePath = process.env.NOMAD_STORAGE_PATH
    if (!storagePath) {
      throw new UnrecoverableError('NOMAD_STORAGE_PATH environment variable is not set')
    }

    const rawHostPath = `${storagePath}/books-raw`
    const zimHostPath = `${storagePath}/zim`
    const image = 'ghcr.io/flynnty/project-nomad-book-builder:latest'

    const updateProgress = async (percent: number, message: string) => {
      const data: BookLibraryProgressData = { percent, message, lastProgressTime: Date.now() }
      await job.updateProgress(data).catch((err) => {
        if (err?.code !== -1) throw err
      })
    }

    await updateProgress(0, 'Pulling book-builder image...')
    logger.info(`[BookLibraryJob] Pulling image ${image}`)

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
      logger.warn(`[BookLibraryJob] Image pull failed (may be offline), using cached image: ${pullErr.message}`)
    }

    await updateProgress(2, 'Starting book-builder container...')

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['--rebuild', '--raw-dir', '/raw', '--zim-dir', '/zim'],
      HostConfig: {
        Binds: [`${rawHostPath}:/raw`, `${zimHostPath}:/zim`],
        AutoRemove: false,
        NetworkMode: 'none',
      },
    })

    try {
      await container.start()
      logger.info(`[BookLibraryJob] Container started: ${container.id.slice(0, 12)}`)

      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: false,
      })

      const progressParser = new Promise<void>((resolve) => {
        let buffer = ''

        const onData = async (chunk: Buffer) => {
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
                logger.info(`[BookLibraryJob] Progress ${pct}%: ${msg}`)
                await updateProgress(pct, msg).catch(() => {})
              } else if (trimmed.startsWith('NOMAD_DONE:')) {
                logger.info(`[BookLibraryJob] Done: ${trimmed}`)
              } else if (trimmed.startsWith('NOMAD_ERROR:')) {
                logger.error(`[BookLibraryJob] Error from builder: ${trimmed}`)
              } else if (trimmed) {
                logger.debug(`[BookLibraryJob] Builder: ${trimmed}`)
              }
            }
          }
        }

        ;(logStream as any).on('data', onData)
        ;(logStream as any).on('end', () => resolve())
        ;(logStream as any).on('error', () => resolve())
      })

      await progressParser

      const result = await container.wait()
      const exitCode = result.StatusCode
      logger.info(`[BookLibraryJob] Container exited with code ${exitCode}`)

      if (exitCode !== 0) {
        throw new Error(`book-builder exited with code ${exitCode}`)
      }

      await updateProgress(99, 'Updating Kiwix library...')
      const kiwixLibrary = new KiwixLibraryService()
      await kiwixLibrary.rebuildFromDisk()

      await updateProgress(100, 'Complete!')
      logger.info('[BookLibraryJob] Book library ZIM built successfully')

    } finally {
      try {
        await container.remove({ force: true })
      } catch {
        // already removed
      }
    }
  }

  static async dispatch() {
    const queueService = new QueueService()
    const queue = queueService.getQueue(this.queue)

    try {
      const job = await queue.add(this.key, {}, {
        jobId: JOB_ID,
        attempts: 2,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
      })
      return { job, created: true }
    } catch (error: any) {
      if (error.message.includes('job already exists')) {
        const existing = await queue.getJob(JOB_ID)
        return { job: existing, created: false }
      }
      throw error
    }
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
