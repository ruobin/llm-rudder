import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";

const STATES: Record<string, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  ok: { label: "Available", tone: "good", icon: CircleCheck },
  cooldown: { label: "Cooling down", tone: "warning", icon: Clock },
  probing: { label: "Rechecking", tone: "warning", icon: LoaderCircle },
  backoff: { label: "Limit reached", tone: "serious", icon: CircleAlert },
  exhausted: { label: "Out of quota", tone: "serious", icon: CircleAlert },
  budget: { label: "Budget reached", tone: "serious", icon: CircleAlert },
  disabled: { label: "Stopped", tone: "critical", icon: CircleSlash },
  signed_out: { label: "Not signed in", tone: "critical", icon: CircleSlash },
  auth_required: { label: "Sign-in needed", tone: "critical", icon: CircleSlash },
};

export function StateBadge({ state }: { state: string }) {
  const known = STATES[state] ?? {
    label: state.replaceAll("_", " "),
    tone: "neutral" as const,
    icon: CircleAlert,
  };
  const Icon = known.icon;
  return (
    <Badge tone={known.tone}>
      <Icon aria-hidden className="size-3" />
      {known.label}
    </Badge>
  );
}

const OUTCOME_TONES: Record<string, BadgeTone> = {
  ok: "good",
  client_aborted: "neutral",
  quota_exhausted: "serious",
  billing: "serious",
  rate_limited: "warning",
  overloaded: "warning",
  timeout: "warning",
  refusal: "neutral",
  client_error: "neutral",
  context_overflow: "neutral",
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const tone = OUTCOME_TONES[outcome] ?? "critical";
  const Icon = tone === "good" ? CircleCheck : tone === "neutral" ? CircleSlash : CircleAlert;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden className="size-3" />
      {outcome === "ok" ? "Served" : outcome.replaceAll("_", " ")}
    </Badge>
  );
}
