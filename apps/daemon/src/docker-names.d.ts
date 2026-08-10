declare module "docker-names" {
  interface DockerNames {
    getRandomName(retry?: boolean | number): string;
    adjectives: string[];
    surnames: string[];
  }

  const dockerNames: DockerNames;
  export default dockerNames;
}
