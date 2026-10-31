import { redirect } from "next/navigation";

export default function LegacyDisconnectAnalysisRoute() {
  redirect("/logs?logTab=sessions&logFeature=disconnects");
}
