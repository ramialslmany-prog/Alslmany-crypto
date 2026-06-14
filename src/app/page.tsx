import { redirect } from "next/navigation";

// No marketing landing — straight into the terminal.
export default function Home() {
  redirect("/dashboard");
}
