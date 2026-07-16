import StepScreen from "@/components/journey/StepScreen";

export const metadata = { title: "Vidi · Setup step" };

export default async function SetupStepPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StepScreen id={id} />;
}
