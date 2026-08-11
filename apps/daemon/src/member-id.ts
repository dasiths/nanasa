import dockerNames from "docker-names";

export type MemberNameGenerator = () => string;

export const dockerMemberName: MemberNameGenerator = () => dockerNames.getRandomName();

export function formatMemberId(randomName: string): string {
  const normalizedName = randomName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  if (normalizedName.length === 0) {
    throw new Error("docker-names returned an unusable member name");
  }
  return normalizedName;
}
