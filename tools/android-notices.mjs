// Usage: node tools/android-notices.mjs [--input artifacts.json] [--output notices.txt] [--check]
//
// Apache-2.0 section 4(d) NOTICE files: checked 2026-10-20 for all 49 Apache-2.0 artifacts of the
// release (incl. org.apache.cordova:framework:14.0.1 and the classes.jar inside each AAR); none ships
// a NOTICE, so only license texts are reproduced. Re-check when the dependency set changes.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT = resolve(
  ROOT,
  'apps/android/android/app/build/reports/licensee/androidRelease/artifacts.json',
);
const OUTPUT = resolve(ROOT, 'web/static/third-party-licenses-android.txt');
const USAGE =
  'Usage: node tools/android-notices.mjs [--input artifacts.json] [--output notices.txt] [--project-root directory] [--check]';

// Canonical Apache-2.0 text, kept offline and emitted once for all Apache dependencies.
const APACHE_2_0 = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and

(b) You must cause any modified files to carry prominent notices stating that You changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

To apply the Apache License to your work, attach the following boilerplate notice, with the fields enclosed by brackets "[]" replaced with your own identifying information. (Don't include the brackets!) The text should be enclosed in the appropriate comment syntax for the file format. We also recommend that a file or class name and description of purpose be included on the same "printed page" as the copyright notice for easier identification within third-party archives.

Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`;

// Keep in sync with licensee { allow(...) } in apps/android/android/app/build.gradle.
export const ALLOWED_SPDX = Object.freeze([
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'EPL-2.0',
]);

/** @typedef {{ identifier: string, name?: string, url?: string }} SpdxLicense */
/** @typedef {{ name?: string, url?: string }} UnknownLicense */
/**
 * @typedef {{ groupId: string, artifactId: string, version: string, name?: string,
 *   scm?: string, spdxLicenses: SpdxLicense[], unknownLicenses: UnknownLicense[], licenseText?: string }} Artifact
 * @typedef {{ project: string, packageName?: string, version?: string, license?: string,
 *   licenseText?: string, empty?: boolean }} BundledProject
 */

/** @param {string} a @param {string} b */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {unknown} value @param {string} context @returns {Record<string, unknown>} */
function record(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected an object: ${context}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} context */
function requiredText(value, context) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing or invalid ${context}`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value @param {string} context */
function optionalText(value, context) {
  return value === undefined ? undefined : requiredText(value, context);
}

/** @param {unknown} value @param {string} context @returns {unknown[]} */
function optionalArray(value, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected an array: ${context}`);
  return value;
}

/** Preserve the complete copyright-bearing license, including paragraph boundaries.
 * @param {unknown} value @param {string} context */
function licenseText(value, context) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Missing license text: ${context}`);
  return value.replaceAll('\r\n', '\n').trim();
}

/** @param {string} directory @returns {string[]} */
function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

/**
 * The generated Cordova manifest declares no components: exactly one <application> element with
 * no child content. Only android:usesCleartextTraffic is tolerated: an e2e `cap sync`
 * (server.cleartext) emits it without bundling code. Other attributes can reference code.
 * @param {string} manifest
 */
export function isEmptyCordovaManifest(manifest) {
  const application = manifest.match(/<application\b([^>]*?)(?:>\s*<\/application\s*>|\/>)/);
  return (
    (manifest.match(/<application\b/g) ?? []).length === 1 &&
    application !== null &&
    /^(?:\s+android:usesCleartextTraffic\s*=\s*(?:"(?:true|false)"|'(?:true|false)'))?\s*$/.test(
      application[1],
    )
  );
}

/**
 * Resolve every non-app Gradle project to its backing npm package. Only the checked-empty,
 * generated Cordova container is exempt; new local projects or bundled code fail closed.
 * @param {string} [root]
 * @returns {BundledProject[]}
 */
export function readBundledProjects(root = ROOT) {
  const gradle = resolve(root, 'apps/android/android');
  const settings = ['settings.gradle', 'capacitor.settings.gradle']
    .map((name) => readFileSync(join(gradle, name), 'utf8'))
    .join('\n');
  const projects = new Set(
    [...settings.matchAll(/^\s*include\s+(.+)$/gm)].flatMap((line) =>
      [...line[1].matchAll(/['"](:[^'"]+)['"]/g)].map((match) => match[1]),
    ),
  );
  const directories = new Map(
    [
      ...settings.matchAll(
        /project\(['"](:[^'"]+)['"]\)\.projectDir\s*=\s*new File\(['"]([^'"]+)['"]\)/g,
      ),
    ].map((match) => [match[1], resolve(gradle, match[2])]),
  );
  return [...projects]
    .filter((project) => project !== ':app')
    .sort(compare)
    .map((project) => {
      const directory = directories.get(project);
      if (!directory) throw new Error(`Missing Gradle projectDir: ${project}`);
      if (project === ':capacitor-cordova-android-plugins') {
        const bundledFiles = ['src', 'libs']
          .flatMap((name) => filesIn(join(directory, name)))
          .filter(
            (path) =>
              !path.endsWith(`${sep}.gitkeep`) &&
              path !== join(directory, 'src/main/AndroidManifest.xml'),
          );
        const manifest = readFileSync(join(directory, 'src/main/AndroidManifest.xml'), 'utf8');
        if (bundledFiles.length || !isEmptyCordovaManifest(manifest)) {
          throw new Error(
            `Bundled Cordova code needs explicit package license attribution: ${project}`,
          );
        }
        return { project, empty: true };
      }
      let packageDir = directory;
      const modules = resolve(root, 'node_modules');
      while (
        packageDir.startsWith(`${modules}${sep}`) &&
        !existsSync(join(packageDir, 'package.json'))
      ) {
        packageDir = dirname(packageDir);
      }
      if (!packageDir.startsWith(`${modules}${sep}`)) {
        throw new Error(`Gradle project has no backing npm package: ${project}`);
      }
      const pkg = record(
        JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')),
        project,
      );
      const license = requiredText(pkg.license, `${project} license`);
      if (!ALLOWED_SPDX.includes(license)) {
        throw new Error(`Disallowed SPDX license ${license}: ${project}`);
      }
      const licenseFile = readdirSync(packageDir)
        .sort(compare)
        .find((name) => /^licen[cs]e(?:\.(?:txt|md))?$/i.test(name));
      if (!licenseFile && license !== 'Apache-2.0')
        throw new Error(`Missing license text: ${project}`);
      return {
        project,
        packageName: requiredText(pkg.name, `${project} package name`),
        version: requiredText(pkg.version, `${project} version`),
        license,
        licenseText: licenseFile
          ? licenseText(
              readFileSync(join(packageDir, licenseFile), 'utf8'),
              relative(root, packageDir),
            )
          : undefined,
      };
    });
}

/**
 * Validate Licensee's JSON without guessing SPDX expressions or accepting unknown-only licenses.
 * Missing license arrays in Licensee 1.14.1 mean empty arrays.
 * @param {unknown} report
 * @returns {Artifact[]}
 */
export function validateArtifacts(report) {
  if (!Array.isArray(report) || !report.length) {
    throw new Error('Expected a non-empty Licensee artifacts array');
  }
  return report.map((entry, index) => {
    const raw = record(entry, `artifact ${index}`);
    const groupId = requiredText(raw.groupId, `groupId at artifact ${index}`);
    const artifactId = requiredText(raw.artifactId, `artifactId at artifact ${index}`);
    const version = requiredText(raw.version, `version at artifact ${index}`);
    const coordinates = `${groupId}:${artifactId}:${version}`;
    const spdxLicenses = optionalArray(raw.spdxLicenses, `${coordinates} spdxLicenses`).map(
      (value) => {
        const license = record(value, `${coordinates} SPDX license`);
        const identifier = requiredText(license.identifier, `${coordinates} SPDX identifier`);
        if (!ALLOWED_SPDX.includes(identifier)) {
          throw new Error(`Disallowed SPDX license ${identifier}: ${coordinates}`);
        }
        return {
          identifier,
          name: optionalText(license.name, `${coordinates} license name`),
          url: optionalText(license.url, `${coordinates} license URL`),
        };
      },
    );
    if (!spdxLicenses.length) throw new Error(`No SPDX license: ${coordinates}`);
    const fullText =
      raw.licenseText === undefined ? undefined : licenseText(raw.licenseText, coordinates);
    if (
      spdxLicenses.some(({ identifier }) => /^(MIT|BSD-2-Clause|BSD-3-Clause)$/.test(identifier)) &&
      !fullText
    ) {
      throw new Error(`Missing copyright-bearing MIT/BSD license text: ${coordinates}`);
    }
    const unknownLicenses = optionalArray(
      raw.unknownLicenses,
      `${coordinates} unknownLicenses`,
    ).map((value) => {
      const license = record(value, `${coordinates} unknown license`);
      return {
        name: optionalText(license.name, `${coordinates} unknown license name`),
        url: optionalText(license.url, `${coordinates} unknown license URL`),
      };
    });
    let scm;
    if (raw.scm !== undefined) {
      scm =
        typeof raw.scm === 'string'
          ? requiredText(raw.scm, `${coordinates} SCM`)
          : optionalText(record(raw.scm, `${coordinates} SCM`).url, `${coordinates} SCM URL`);
    }
    return {
      groupId,
      artifactId,
      version,
      name: optionalText(raw.name, `${coordinates} project name`),
      scm,
      spdxLicenses,
      unknownLicenses,
      licenseText: fullText,
    };
  });
}

/**
 * Pure, deterministic render: no network, timestamps, locale ordering or absolute paths.
 * @param {unknown} report
 * @param {BundledProject[]} [projects]
 * @returns {string}
 */
export function renderNotices(report, projects = []) {
  const artifacts = validateArtifacts(report);
  const entries = artifacts.map((artifact) => {
    const coordinates = `${artifact.groupId}:${artifact.artifactId}:${artifact.version}`;
    const licenses = artifact.spdxLicenses
      .map(
        ({ identifier, name, url }) =>
          `SPDX: ${identifier}${name ? ` (${name})` : ''}\n` +
          `License URL: ${url ?? `https://spdx.org/licenses/${identifier}.html`}`,
      )
      .sort(compare);
    const unknown = artifact.unknownLicenses
      .map(
        ({ name, url }) =>
          `Other reported license: ${name ?? 'Unidentified'}${url ? ` (${url})` : ''}`,
      )
      .sort(compare);
    const text = [
      `Coordinates: ${coordinates}`,
      `Version: ${artifact.version}`,
      ...(artifact.name ? [`Project: ${artifact.name}`] : []),
      ...(artifact.scm ? [`SCM: ${artifact.scm}`] : []),
      ...licenses,
      ...unknown,
      ...(artifact.licenseText ? [`Full license text:\n${artifact.licenseText}`] : []),
      ...(artifact.spdxLicenses.some(({ identifier }) => identifier === 'Apache-2.0')
        ? ['Full Apache-2.0 text: see the canonical license at the end of this file.']
        : []),
    ].join('\n');
    return { coordinates, text };
  });
  entries.sort((a, b) => compare(a.coordinates, b.coordinates) || compare(a.text, b.text));
  const bundled = [...projects]
    .sort((a, b) => compare(a.project, b.project))
    .map((project) => {
      if (project.empty) {
        return `Gradle project: ${project.project}\nGenerated empty Cordova container; no bundled third-party project code. Maven dependencies are listed below.\n`;
      }
      if (!project.license || !ALLOWED_SPDX.includes(project.license)) {
        throw new Error(`Disallowed SPDX license: ${project.project}`);
      }
      const text = project.licenseText
        ? `Full license text:\n${licenseText(project.licenseText, project.project)}\n`
        : project.license === 'Apache-2.0'
          ? 'Full Apache-2.0 text: see the canonical license at the end of this file.\n'
          : licenseText(undefined, project.project);
      return (
        `Gradle project: ${project.project}\nPackage: ${requiredText(project.packageName, 'package name')}\n` +
        `Version: ${requiredText(project.version, 'package version')}\nSPDX: ${project.license}\n${text}`
      );
    });
  const apache =
    artifacts.some((artifact) =>
      artifact.spdxLicenses.some(({ identifier }) => identifier === 'Apache-2.0'),
    ) || projects.some(({ license }) => license === 'Apache-2.0');
  return (
    'Third-party licenses for the open-auri Android app (native dependencies)\n' +
    'Repository: https://github.com/marco-jardim/open-auri\n' +
    'Generated from the Licensee androidRelease artifacts.json report and Gradle project npm packages. Do not edit by hand.\n' +
    'Regenerate: npm run build:android:release && node tools/android-notices.mjs\n' +
    'These notices include license identifiers, URLs and bundled project license texts.\n\n' +
    'Bundled project dependencies\n\n' +
    bundled.map((text) => `${'='.repeat(80)}\n${text}`).join('\n') +
    '\nMaven dependencies (Licensee)\n\n' +
    entries.map(({ text }) => `${'='.repeat(80)}\n${text}\n`).join('\n') +
    (apache ? `\n${'='.repeat(80)}\nCanonical Apache-2.0 license text\n\n${APACHE_2_0}` : '')
  );
}

/** @param {string[]} args */
export function parseArgs(args) {
  let input = INPUT;
  let output = OUTPUT;
  let projectRoot = ROOT;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') check = true;
    else if (
      ['--input', '--output', '--project-root'].includes(arg) &&
      args[index + 1]?.[0] !== '-'
    ) {
      const value = args[++index];
      if (!value) throw new Error(USAGE);
      if (arg === '--input') input = resolve(value);
      else if (arg === '--output') output = resolve(value);
      else projectRoot = resolve(value);
    } else throw new Error(USAGE);
  }
  return { input, output, projectRoot, check };
}

/** @param {string[]} args */
export function main(args) {
  const { input, output, projectRoot, check } = parseArgs(args);
  const text = renderNotices(
    JSON.parse(readFileSync(input, 'utf8')),
    readBundledProjects(projectRoot),
  );
  if (check) {
    if (readFileSync(output, 'utf8') !== text) {
      throw new Error(`Android notices drift: regenerate ${output} from ${input}`);
    }
    console.log(`Android notices are up to date: ${output}`);
  } else {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text, 'utf8');
    console.log(`Wrote Android notices to ${output}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
