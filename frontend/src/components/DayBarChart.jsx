export default function DayBarChart({ byDay }) {
  if (!byDay.length) return <div className="empty">No data yet.</div>
  const max = Math.max(1, ...byDay.map(d => Math.max(d.bookings, d.releases)))
  return (
    <div className="daychart">
      {byDay.map(d => (
        <div className="daychart-col" key={d.date}>
          <div className="daychart-bars">
            <div
              className="daychart-bar daychart-bookings"
              style={{ height: `${(d.bookings / max) * 100}%` }}
              title={`${d.bookings} booked`}
            />
            <div
              className="daychart-bar daychart-releases"
              style={{ height: `${(d.releases / max) * 100}%` }}
              title={`${d.releases} released`}
            />
          </div>
          <div className="daychart-label">{d.date.slice(5)}</div>
        </div>
      ))}
    </div>
  )
}
