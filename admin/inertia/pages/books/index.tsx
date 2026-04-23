import { Head } from '@inertiajs/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import AppLayout from '~/layouts/AppLayout'
import StyledButton from '~/components/StyledButton'
import Alert from '~/components/Alert'
import api from '~/lib/api'
import { useNotifications } from '~/context/NotificationContext'
import {
  IconBook,
  IconExternalLink,
  IconFileTypePdf,
  IconLoader,
  IconTrash,
  IconX,
} from '@tabler/icons-react'

const KIWIX_PORT = 8090
const POLL_INTERVAL_MS = 3000

function getMyLibraryUrl(): string {
  return `http://${window.location.hostname}:${KIWIX_PORT}/viewer#my_book_library/index.html`
}

type JobStatus = 'waiting' | 'active' | 'delayed' | 'failed'

interface BookJob {
  jobId: string
  percent: number
  message: string
  lastProgressTime?: number
  status: JobStatus
  failedReason?: string
}

interface Book {
  id: string
  title: string
  author: string
  description: string
  mime_type: string
}

function BookTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === 'application/pdf') {
    return <IconFileTypePdf size={20} className="text-red-400 shrink-0" />
  }
  return <IconBook size={20} className="text-desert-green shrink-0" />
}

function BookTypeLabel({ mimeType }: { mimeType: string }) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary text-text-secondary">
      {mimeType === 'application/pdf' ? 'PDF' : 'EPUB'}
    </span>
  )
}

export default function BooksPage() {
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addNotification } = useNotifications()
  const queryClient = useQueryClient()

  // Poll active jobs
  const { data: jobs = [] } = useQuery<BookJob[]>({
    queryKey: ['book-jobs'],
    queryFn: async () => {
      const res = await api.listBookJobs()
      return res ?? []
    },
    refetchInterval: (query) => {
      const data = query.state.data ?? []
      const hasActive = data.some((j) => j.status !== 'failed')
      return hasActive ? POLL_INTERVAL_MS : false
    },
  })

  const hasActiveJobs = jobs.some((j) => j.status !== 'failed')

  // Book list
  const { data: books = [], isLoading: booksLoading } = useQuery<Book[]>({
    queryKey: ['book-list'],
    queryFn: async () => {
      const res = await api.listBooks()
      return res ?? []
    },
    refetchInterval: hasActiveJobs ? POLL_INTERVAL_MS : false,
  })

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadBook(file),
    onSuccess: (data) => {
      if (data) {
        addNotification({
          type: 'success',
          title: 'Upload started',
          message: 'Your book is being added to the library. This may take a moment.',
        })
        if (fileInputRef.current) fileInputRef.current.value = ''
        queryClient.invalidateQueries({ queryKey: ['book-jobs'] })
        queryClient.invalidateQueries({ queryKey: ['book-list'] })
      }
    },
    onError: (error: Error) => {
      setFileError(error.message || 'Upload failed. Please try again.')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteBook(id),
    onSuccess: () => {
      addNotification({
        type: 'success',
        title: 'Deleted',
        message: 'Book removed and library rebuilt.',
      })
      queryClient.invalidateQueries({ queryKey: ['book-list'] })
      queryClient.invalidateQueries({ queryKey: ['book-jobs'] })
    },
  })

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    const file = e.target.files?.[0]
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ext || !['epub', 'pdf'].includes(ext)) {
      setFileError('Only .epub and .pdf files are supported.')
      return
    }
    uploadMutation.mutate(file)
  }

  function confirmDelete(id: string, title: string) {
    if (confirm(`Delete "${title}"? The book will be removed and the library rebuilt.`)) {
      deleteMutation.mutate(id)
    }
  }

  const activeJobs = jobs.filter((j) => j.status !== 'failed')
  const failedJobs = jobs.filter((j) => j.status === 'failed')

  return (
    <AppLayout>
      <Head title="My Library | Project N.O.M.A.D." />
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <IconBook size={40} className="text-desert-green" />
          <div>
            <h1 className="text-3xl font-bold">My Library</h1>
            <p className="text-text-secondary text-sm mt-1">
              Upload epub and PDF books for offline reading via the Information Library
            </p>
          </div>
        </div>

        {/* Upload form */}
        <div className="bg-surface-primary border border-desert-stone-light rounded-lg p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Add a Book</h2>
          <p className="text-sm text-text-secondary mb-4">
            Upload an <strong>.epub</strong> or <strong>.pdf</strong> file. It will be packaged into
            your personal library ZIM and made available in Kiwix.
          </p>
          <div className="flex flex-col gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".epub,.pdf"
              onChange={handleFileChange}
              disabled={uploadMutation.isPending}
              className="hidden"
              id="book-file-input"
            />
            <div className="flex gap-3">
              <StyledButton
                type="button"
                variant="primary"
                loading={uploadMutation.isPending}
                disabled={uploadMutation.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadMutation.isPending ? 'Uploading...' : 'Choose File'}
              </StyledButton>
            </div>
            {fileError && <p className="text-sm text-red-500">{fileError}</p>}
            {uploadMutation.error && (
              <p className="text-sm text-red-500">Upload failed. Please try again.</p>
            )}
          </div>
        </div>

        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Building Library</h2>
            <div className="flex flex-col gap-3">
              {activeJobs.map((job) => (
                <div
                  key={job.jobId}
                  className="bg-surface-primary border border-desert-stone-light rounded-lg p-4"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-sm text-text-secondary">
                      {job.message || (job.status === 'waiting' ? 'Queued...' : 'Processing...')}
                    </p>
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
            <h2 className="text-lg font-semibold mb-3">Failed Builds</h2>
            <div className="flex flex-col gap-2">
              {failedJobs.map((job) => (
                <div
                  key={job.jobId}
                  className="bg-red-900/20 border border-red-700/30 rounded-lg p-4 flex items-start justify-between gap-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Library build failed</p>
                    {job.failedReason && (
                      <p className="text-xs text-red-400 mt-0.5 line-clamp-2">{job.failedReason}</p>
                    )}
                  </div>
                  <button
                    className="shrink-0 text-text-secondary hover:text-red-500 transition-colors"
                    onClick={() => {
                      api.dismissBookJob(job.jobId).then(() => {
                        queryClient.invalidateQueries({ queryKey: ['book-jobs'] })
                      })
                    }}
                  >
                    <IconX size={18} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Book list */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">
              My Books {books.length > 0 && `(${books.length})`}
            </h2>
            {books.length > 0 && (
              <a
                href={getMyLibraryUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-desert-green hover:underline"
              >
                <IconExternalLink size={16} />
                Open in Kiwix
              </a>
            )}
          </div>

          {booksLoading ? (
            <div className="flex items-center justify-center py-12 text-text-secondary">
              <IconLoader size={24} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : books.length === 0 ? (
            <div className="bg-surface-primary border border-desert-stone-light rounded-lg p-8 text-center text-text-secondary">
              <IconBook size={40} className="mx-auto mb-3 opacity-30" />
              <p>No books added yet.</p>
              <p className="text-sm mt-1">Upload an epub or PDF file above to get started.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {books.map((book) => (
                <div
                  key={book.id}
                  className="bg-surface-primary border border-desert-stone-light rounded-lg p-4 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <BookTypeIcon mimeType={book.mime_type} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{book.title}</p>
                        <BookTypeLabel mimeType={book.mime_type} />
                      </div>
                      {book.author && (
                        <p className="text-xs text-text-secondary">{book.author}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => confirmDelete(book.id, book.title)}
                    disabled={deleteMutation.isPending}
                    className="text-text-secondary hover:text-red-500 transition-colors shrink-0"
                    title="Delete book"
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info footer */}
        <div className="mt-8 p-4 bg-surface-primary border border-desert-stone-light rounded-lg">
          <h3 className="text-sm font-semibold mb-2">How it works</h3>
          <ul className="text-sm text-text-secondary space-y-1 list-disc list-inside">
            <li>Upload any <strong>.epub</strong> or <strong>.pdf</strong> file</li>
            <li>All books are packaged into a single "My Library" ZIM served by Kiwix</li>
            <li>epub files are rendered as paginated chapters with navigation</li>
            <li>PDF files are displayed using your browser's built-in PDF viewer</li>
            <li>Adding or deleting a book triggers a library rebuild automatically</li>
          </ul>
        </div>
      </div>
    </AppLayout>
  )
}
