import { ScrollText } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback";
import { PageHeader } from "../components/ui/page";
import { errorMessage } from "../lib/api/errors";
import { useAuditLog } from "../lib/api/audit";
import { formatDateTime } from "../lib/format";

/** Readable labels for entity types; unknown ones are shown as sent. */
const ENTITY_LABELS: Record<string, string> = {
  device: "TV",
  location: "Konum",
  media: "Medya",
  playlist: "Liste",
  schedule: "Zamanlama",
  user: "Kullanıcı",
  invite: "Davet",
  command: "Komut",
};

export function AuditPage() {
  const audit = useAuditLog();
  const entries = audit.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader
        title="İşlem kaydı"
        description="Paneldeki her değişiklik: kim, ne zaman, ne yaptı. En yeni kayıt en üstte."
        actions={
          <Button size="sm" onClick={() => void audit.refetch()} pending={audit.isRefetching && !audit.isFetchingNextPage}>
            Yenile
          </Button>
        }
      />
      {audit.isPending ? (
        <LoadingState />
      ) : audit.isError && entries.length === 0 ? (
        // A failed "load more" keeps the loaded pages; only a failed first load replaces the table.
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="Henüz kayıt yok">
          TV eklemek, medya yüklemek, kullanıcı davet etmek gibi işlemler burada listelenir.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="panel overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Kişi</th>
                  <th scope="col">İşlem</th>
                  <th scope="col">Kayıt</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-ink-2 tabular-nums">{formatDateTime(entry.at)}</td>
                    <td className="whitespace-nowrap">{entry.userName ?? "Sistem"}</td>
                    <td className="min-w-64">
                      <span className="block">{entry.summary}</span>
                      <span className="block text-xs text-ink-3">{entry.action}</span>
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{ENTITY_LABELS[entry.entityType] ?? entry.entityType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col items-center gap-2">
            {audit.hasNextPage ? (
              <Button onClick={() => void audit.fetchNextPage()} pending={audit.isFetchingNextPage}>
                Daha eski kayıtları yükle
              </Button>
            ) : (
              <p className="text-sm text-ink-3">Kaydın başına ulaşıldı ({entries.length} kayıt).</p>
            )}
            {audit.isError && <p className="text-sm text-bad">{errorMessage(audit.error)}</p>}
          </div>
        </div>
      )}
    </>
  );
}
