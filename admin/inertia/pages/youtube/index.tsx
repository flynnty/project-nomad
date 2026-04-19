import { Head } from '@inertiajs/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useRef } from 'react'
import AppLayout from '~/layouts/AppLayout'
import StyledButton from '~/components/StyledButton'
import Alert from '~/components/Alert'
import api from '~/lib/api'
import { useNotifications } from '~/context/NotificationContext'
import { IconBrandYoutube, IconTrash, IconExternalLink, IconX, IconLoader } from '@tabler/icons-react'

const KIWIX_PORT = 8090
const POLL_INTERVAL_MS = 3000

function getKiwixUrl(): string {
  return `http://${window.location.hostname}:${KIWIX_PORT}`
}

function getBestOfYoutubeUrl(): string {
  return `${getKiwixUrl()}/viewer#youtube_library/index.html`
}

type JobStatus = 'waiting' | 'active' | 'delayed' | 'failed'

interface YoutubeJob {
  jobId: string
  url: string
  percent: number
  message: string
  lastProgressTime?: number
  status: JobStatus
  failedReason?: string
}

interface YoutubeChannel {
  id: string
  name: string
  description: string
  videoCount: number
}

interface YoutubeVideo {
  id: string
  title: string
  channel: string
  duration: string
  uploadDate: string
}

export default function YoutubePage() {
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const { addNotification } = useNotifications()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)

  // Poll active jobs
  const { data: jobs = [] } = useQuery<YoutubeJob[]>({
    queryKey: ['youtube-jobs'],
    queryFn: async () => {
      const res = await api.listYoutubeJobs()
      return res ?? []
    },
    refetchInterval: (query) => {
      const data = query.state.data ?? []
      const hasActive = data.some((j) => j.status !== 'failed')
      return hasActive ? POLL_INTERVAL_MS : false
    },
  })

  const hasActiveJobs = jobs.some((j) => j.status !== 'failed')

  // Library content
  const { data: content, isLoading: contentLoading } = useQuery<{
    channels: YoutubeChannel[]
    videos: YoutubeVideo[]
  }>({
    queryKey: ['youtube-content'],
    queryFn: async () => {
      const res = await api.listYoutubeContent()
      return res ?? { channels: [], videos: [] }
    },
    refetchInterval: hasActiveJobs ? POLL_INTERVAL_MS : false,
  })

  const channels = content?.channels ?? []
  const videos = content?.videos ?? []
  const hasContent = channels.length > 0 || videos.length > 0

  const downloadMutation = useMutation({
    mutationFn: (downloadUrl: string) => api.downloadYoutubeContent(downloadUrl),
    onSuccess: (data) => {
      if (data) {
        addNotification({
          type: 'success',
          title: 'Download started',
          message: 'Your YouTube content is being downloaded and packaged. This may take a while.',
        })
        setUrl('')
        queryClient.invalidateQueries({ queryKey: ['youtube-jobs'] })
      }
    },
    onError: () => {
      setUrlError('Download failed. Please check the URL and try again.')
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) => api.cancelYoutubeJob(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['youtube-jobs'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: ({ type, id }: { type: 'channel' | 'video'; id: string }) =>
      api.deleteYoutubeItem(type, id),
    onSuccess: () => {
      addNotification({ type: 'success', title: 'Deleted', message: 'Content removed and library rebuilt.' })
      queryClient.invalidateQueries({ queryKey: ['youtube-content'] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setUrlError(null)
    const trimmed = url.trim()
    if (!trimmed) {
      setUrlError('Please enter a YouTube URL.')
      return
    }
    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) {
      setUrlError('Please enter a valid youtube.com or youtu.be URL.')
      return
    }
    downloadMutation.mutate(trimmed)
  }

  function confirmDelete(type: 'channel' | 'video', id: string, label: string) {
    if (confirm(`Delete "${label}"? The raw files will be removed and the library will be rebuilt.`)) {
      deleteMutation.mutate({ type, id })
    }
  }

  const activeJobs = jobs.filter((j) => j.status !== 'failed')
  const failedJobs = jobs.filter((j) => j.status === 'failed')

  return (
    <AppLayout>
      <Head title="YouTube Library | Project N.O.M.A.D." />
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <IconBrandYoutube size={40} className="text-red-500" />
          <div>
            <h1 className="text-3xl font-bold">YouTube Library</h1>
            <p className="text-text-secondary text-sm mt-1">
              Download YouTube videos and channels for offline access via the Information Library
            </p>
          </div>
        </div>

        <Alert
          type="info"
          title="Downloads require an active internet connection and may take a long time for full channels."
          className="mb-6"
        />

        {/* Download form */}
        <div className="bg-surface-primary border border-desert-stone-light rounded-lg p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Add YouTube Content</h2>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label htmlFor="yt-url" className="block text-sm font-medium text-text-secondary mb-1">
                YouTube URL (video or channel)
              </label>
              <input
                id="yt-url"
                ref={inputRef}
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setUrlError(null) }}
                placeholder="https://www.youtube.com/watch?v=... or https://www.youtube.com/@ChannelName"
                className="w-full rounded-md border border-desert-stone-light bg-surface-secondary text-text-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-desert-green"
              />
              {urlError && <p className="mt-1 text-sm text-red-500">{urlError}</p>}
            </div>
            {downloadMutation.error && (
              <p className="text-sm text-red-500">Download failed. Please try again.</p>
            )}
            <div className="flex gap-3">
              <StyledButton
                type="submit"
                variant="primary"
                loading={downloadMutation.isPending}
                disabled={downloadMutation.isPending}
              >
                Download
              </StyledButton>
              {url && (
                <StyledButton
                  type="button"
                  variant="secondary"
                  onClick={() => { setUrl(''); setUrlError(null) }}
                >
                  Clear
                </StyledButton>
              )}
            </div>
          </form>
        </div>

        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Downloads in Progress</h2>
            <div className="flex flex-col gap-3">
              {activeJobs.map((job) => (
                <div key={job.jobId} className="bg-surface-primary border border-desert-stone-light rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{job.url}</p>
                      <p className="text-xs text-text-secondary mt-0.5">
                        {job.message || (job.status === 'waiting' ? 'Queued...' : 'Processing...')}
                      </p>
                    </div>
                    <button
                      onClick={() => cancelMutation.mutate(job.jobId)}
                      className="shrink-0 text-text-secondary hover:text-red-500 transition-colors"
                      title="Cancel"
                    >
                      <IconX size={18} />
                    </button>
                  </div>
                  <div className="w-full bg-desert-stone-light rounded-full h-2">
                    <div
                      className="bg-desert-green h-2 rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(2, job.percent)}%` }}
                    />
                  </div>
                  <p className="text-xs text-text-secondary mt-1 text-right">{job.percent}%</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Failed jobs */}
        {failedJobs.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Failed Downloads</h2>
            <div className="flex flex-col gap-2">
              {failedJobs.map((job) => (
                <div key={job.jobId} className="bg-red-900/20 border border-red-700/30 rounded-lg p-4 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{job.url}</p>
                    {job.failedReason && (
                      <p className="text-xs text-red-400 mt-0.5 line-clamp-2">{job.failedReason}</p>
                    )}
                  </div>
                  <button
                    onClick={() => cancelMutation.mutate(job.jobId)}
                    className="shrink-0 text-text-secondary hover:text-red-500 transition-colors"
                    title="Dismiss"
                  >
                    <IconX size={18} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Library */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Best of YouTube</h2>
            {hasContent && (
              <a
                href={getBestOfYoutubeUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-desert-green hover:underline"
              >
                <IconExternalLink size={16} />
                Open in Kiwix
              </a>
            )}
          </div>

          {contentLoading ? (
            <div className="flex items-center justify-center py-12 text-text-secondary">
              <IconLoader size={24} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : !hasContent ? (
            <div className="bg-surface-primary border border-desert-stone-light rounded-lg p-8 text-center text-text-secondary">
              <IconBrandYoutube size={40} className="mx-auto mb-3 opacity-30" />
              <p>No YouTube content downloaded yet.</p>
              <p className="text-sm mt-1">Enter a YouTube URL above to get started.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">

              {/* Channels */}
              {channels.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">
                    Channels ({channels.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {channels.map((ch) => (
                      <div
                        key={ch.id}
                        className="bg-surface-primary border border-desert-stone-light rounded-lg p-4 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <IconBrandYoutube size={24} className="text-red-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{ch.name}</p>
                            <p className="text-xs text-text-secondary">
                              {ch.videoCount} video{ch.videoCount !== 1 ? 's' : ''}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => confirmDelete('channel', ch.id, ch.name)}
                          disabled={deleteMutation.isPending}
                          className="text-text-secondary hover:text-red-500 transition-colors shrink-0"
                          title="Delete channel"
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Standalone videos */}
              {videos.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-2">
                    Videos ({videos.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {videos.map((v) => (
                      <div
                        key={v.id}
                        className="bg-surface-primary border border-desert-stone-light rounded-lg p-4 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <IconBrandYoutube size={24} className="text-red-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{v.title}</p>
                            <p className="text-xs text-text-secondary">
                              {[v.channel, v.uploadDate, v.duration].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => confirmDelete('video', v.id, v.title)}
                          disabled={deleteMutation.isPending}
                          className="text-text-secondary hover:text-red-500 transition-colors shrink-0"
                          title="Delete video"
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Info footer */}
        <div className="mt-8 p-4 bg-surface-primary border border-desert-stone-light rounded-lg">
          <h3 className="text-sm font-semibold mb-2">How it works</h3>
          <ul className="text-sm text-text-secondary space-y-1 list-disc list-inside">
            <li>Single video URLs download just that video at up to 480p quality</li>
            <li>Channel URLs (<code>@ChannelName</code>, <code>/channel/</code>) download all public videos</li>
            <li>Up to 100 top-level comments are included per video</li>
            <li>All content is combined into a single "Best of YouTube" entry in the Information Library (Kiwix)</li>
            <li>Channel downloads can take a very long time — leave the device running</li>
          </ul>
        </div>
      </div>
    </AppLayout>
  )
}
