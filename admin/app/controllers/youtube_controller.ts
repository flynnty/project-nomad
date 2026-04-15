import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { YoutubeService } from '#services/youtube_service'
import vine from '@vinejs/vine'

const downloadValidator = vine.compile(
  vine.object({
    url: vine.string().url().trim(),
  })
)

const filenameValidator = vine.compile(
  vine.object({
    params: vine.object({
      filename: vine.string().trim(),
    }),
  })
)

const jobIdValidator = vine.compile(
  vine.object({
    params: vine.object({
      jobId: vine.string().trim(),
    }),
  })
)

@inject()
export default class YoutubeController {
  constructor(private youtubeService: YoutubeService) {}

  async index({ inertia }: HttpContext) {
    return inertia.render('youtube/index')
  }

  async download({ request, response }: HttpContext) {
    const payload = await request.validateUsing(downloadValidator)

    try {
      const result = await this.youtubeService.download(payload.url)
      return {
        message: result.message,
        jobId: result.jobId,
        url: payload.url,
      }
    } catch (err: any) {
      if (err.message === 'invalid_url') {
        return response.status(422).send({
          message: 'Invalid YouTube URL. Please enter a valid youtube.com or youtu.be URL.',
        })
      }
      throw err
    }
  }

  async list() {
    return this.youtubeService.list()
  }

  async listJobs() {
    return this.youtubeService.listJobs()
  }

  async cancelJob({ request }: HttpContext) {
    const payload = await request.validateUsing(jobIdValidator)
    return this.youtubeService.cancelJob(payload.params.jobId)
  }

  async delete({ request, response }: HttpContext) {
    const payload = await request.validateUsing(filenameValidator)

    try {
      await this.youtubeService.delete(payload.params.filename)
      return { message: 'YouTube ZIM deleted successfully.' }
    } catch (err: any) {
      if (err.message === 'not_found') {
        return response.status(404).send({ message: 'File not found.' })
      }
      throw err
    }
  }
}
