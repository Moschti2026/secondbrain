import { redirect } from "next/navigation";
import { auth } from "@/auth";
import ChatPanel from "@/components/ChatPanel";

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Chat</h1>
      <ChatPanel />
    </div>
  );
}
