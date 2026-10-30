// Releases (see docs/releasing.md):
//
//   bun run release 0.2.0          bumps the version on a release branch and opens its PR
//   bun run release 0.2.0-beta.1   same, for a pre-release (beta channel)
//   bun run release                after that PR is merged: tags master with the version
//                                  and pushes the tag, which starts the release workflow
import { $ } from "bun";

const SEMVER = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const pkgFile = Bun.file("package.json");
const pkg = (await pkgFile.json()) as { version: string };

if ((await $`git status --porcelain`.text()).trim()) fail("The working tree has changes: commit or stash them first.");
await $`git fetch origin --tags --quiet`;

const next = process.argv[2];
if (next) {
  if (!SEMVER.test(next)) fail(`"${next}" isn't a version like 0.2.0 or 0.2.0-beta.1.`);
  if (next === pkg.version) fail(`The version is already ${next}.`);
  const branch = `release/v${next}`;
  await $`git switch --quiet -c ${branch} origin/master`;
  await Bun.write(pkgFile, (await pkgFile.text()).replace(`"version": "${pkg.version}"`, `"version": "${next}"`));
  await $`git commit --quiet -am ${`Release ${next}`}`;
  await $`git push --quiet -u origin ${branch}`;
  await $`gh pr create --base master --head ${branch} --title ${`Release ${next}`} --body ${`Bumps the version to ${next}. After merging, run \`bun run release\` on master to tag it.`}`;
  console.log(`✓ Opened the release PR for ${next}. Merge it, then run \`bun run release\` on master.`);
} else {
  const tag = `v${pkg.version}`;
  if ((await $`git branch --show-current`.text()).trim() !== "master") fail("Tag releases from master.");
  if ((await $`git rev-parse HEAD`.text()) !== (await $`git rev-parse origin/master`.text()))
    fail("master isn't in sync with origin/master: pull first.");
  if ((await $`git tag --list ${tag}`.text()).trim())
    fail(`${tag} exists already. Bump the version first: bun run release <version>.`);
  await $`git tag -a ${tag} -m ${`Rune Browser ${pkg.version}`}`;
  await $`git push --quiet origin ${tag}`;
  console.log(
    `✓ Pushed ${tag}. The release workflow builds, tests and publishes it: https://github.com/nayupls1/rune-browser/actions`,
  );
}
