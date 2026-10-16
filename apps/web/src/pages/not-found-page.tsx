import { MonitorOff } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "../components/ui/feedback";

export function NotFoundPage() {
  return (
    <EmptyState
      icon={MonitorOff}
      title="Sayfa bulunamadı"
      action={
        <Link to="/devices" className="text-base font-medium text-accent hover:underline">
          Ekranlara dön
        </Link>
      }
    >
      Adres yanlış yazılmış ya da sayfa kaldırılmış olabilir.
    </EmptyState>
  );
}
