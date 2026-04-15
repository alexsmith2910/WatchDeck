import { useParams } from 'react-router-dom'

export default function IncidentDetailPage() {
  const { id } = useParams()
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Incident {id}</h1>
    </div>
  )
}
