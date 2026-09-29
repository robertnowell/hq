import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The preview address, kept so its links land: the home is the front door now (29 Sep, cll.5). */
export default async function HomePreview({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(tab ? `/?tab=${encodeURIComponent(tab)}` : "/");
}
