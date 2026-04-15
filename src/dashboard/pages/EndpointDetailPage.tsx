import { useParams } from 'react-router-dom'

export default function EndpointDetailPage() {
  const { id } = useParams()
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Endpoint {id}</h1>
    </div>
  )
}
