import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { BookService } from '#services/book_service'
import { BookLibraryJob } from '#jobs/book_library_job'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { BOOKS_RAW_PATH } from '../utils/fs.js'

const ALLOWED_EXTS = ['epub', 'pdf']
const MAX_FILE_SIZE = '500mb'

@inject()
export default class BookController {
  constructor(private bookService: BookService) {}

  async index({ inertia }: HttpContext) {
    return inertia.render('books/index')
  }

  async upload({ request, response }: HttpContext) {
    const file = request.file('file', { size: MAX_FILE_SIZE })

    if (!file) {
      return response.status(400).json({ message: 'No file uploaded.' })
    }

    const ext = file.clientName?.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTS.includes(ext)) {
      return response.status(422).json({ message: 'Only .epub and .pdf files are supported.' })
    }

    if (!file.isValid) {
      return response.status(422).json({
        message: file.errors.map((e) => e.message).join('; '),
      })
    }
    const mimeType = ext === 'pdf' ? 'application/pdf' : 'application/epub+zip'

    // Strip extension and sanitize for a human-readable title seed
    const rawName = file.clientName.replace(/\.[^.]+$/, '')
    const title = rawName.replace(/[_-]+/g, ' ').trim()

    const bookId = randomUUID()
    const bookDir = join(process.cwd(), BOOKS_RAW_PATH, bookId)
    await mkdir(bookDir, { recursive: true })

    await file.move(bookDir, { name: `source.${ext}` })

    if (!file.isValid || file.state !== 'moved') {
      return response.status(500).json({ message: 'Failed to save uploaded file.' })
    }

    const info = {
      title,
      author: '',
      description: '',
      publisher: '',
      date: '',
      mime_type: mimeType,
    }
    await writeFile(join(bookDir, 'info.json'), JSON.stringify(info, null, 2))

    await BookLibraryJob.dispatch()

    return response.status(202).json({
      message: 'Book uploaded. Building library in the background.',
      bookId,
    })
  }

  async list() {
    return this.bookService.list()
  }

  async listJobs() {
    return this.bookService.listJobs()
  }

  async dismissJob({ response, params }: HttpContext) {
    const id = params.id as string
    await BookLibraryJob.dismissJob(id)
    return response.status(204).send('')
  }

  async delete({ response, params }: HttpContext) {
    const id = params.id as string

    try {
      await this.bookService.delete(id)
      return { message: 'Deleted successfully.' }
    } catch (err: any) {
      if (err.message === 'invalid_id') {
        return response.status(422).json({ message: 'Invalid book ID.' })
      }
      throw err
    }
  }
}
