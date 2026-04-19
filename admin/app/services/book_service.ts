import { inject } from '@adonisjs/core'
import { readdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { ensureDirectoryExists, BOOKS_RAW_PATH } from '../utils/fs.js'
import { KiwixLibraryService } from './kiwix_library_service.js'
import { BookLibraryJob, BookLibraryProgressData } from '#jobs/book_library_job'

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
export class BookService {
  constructor(private kiwixLibraryService: KiwixLibraryService) {}

  async list() {
    const booksRawPath = join(process.cwd(), BOOKS_RAW_PATH)
    await ensureDirectoryExists(booksRawPath)
    const bookIds = await listSubdirs(booksRawPath)
    const books = await Promise.all(
      bookIds.map(async (id) => {
        const info = await readJsonSafe(join(booksRawPath, id, 'info.json'))
        return {
          id,
          title: (info.title as string) || id,
          author: (info.author as string) || '',
          description: (info.description as string) || '',
          mime_type: (info.mime_type as string) || 'application/epub+zip',
        }
      })
    )
    return books
  }

  async delete(id: string): Promise<void> {
    if (!id || !/^[\w-]+$/.test(id)) {
      throw new Error('invalid_id')
    }

    const targetPath = join(process.cwd(), BOOKS_RAW_PATH, id)
    await rm(targetPath, { recursive: true, force: true })

    await BookLibraryJob.dispatch()
    await this.kiwixLibraryService.rebuildFromDisk()
  }

  async listJobs() {
    const { waiting, active, delayed, failed } = await BookLibraryJob.listJobs()

    type JobState = 'waiting' | 'active' | 'delayed' | 'failed'
    const tagged = [
      ...waiting.map((j) => ({ job: j, state: 'waiting' as JobState })),
      ...active.map((j) => ({ job: j, state: 'active' as JobState })),
      ...delayed.map((j) => ({ job: j, state: 'delayed' as JobState })),
      ...failed.map((j) => ({ job: j, state: 'failed' as JobState })),
    ]

    return tagged.map(({ job, state }) => {
      const raw = job.progress as any
      const progress: BookLibraryProgressData | null =
        raw && typeof raw === 'object' && 'percent' in raw ? raw : null

      return {
        jobId: job.id!.toString(),
        percent: progress?.percent ?? 0,
        message: progress?.message ?? '',
        lastProgressTime: progress?.lastProgressTime,
        status: state,
        failedReason: job.failedReason || undefined,
      }
    })
  }
}
