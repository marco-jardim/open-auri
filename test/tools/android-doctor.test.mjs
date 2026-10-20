import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { checkAll, main } from '../../tools/android-doctor.mjs';

const HOME = join('fixture', 'home');
const JAVA = join('fixture', 'jdk');
const SDK = join('fixture', 'sdk');
const PROPERTIES = join(HOME, '.gradle', 'gradle.properties');
const IMAGE = join(SDK, 'system-images', 'android-36', 'google_apis', 'x86_64');

function fixture() {
  const files = new Map([[join(JAVA, 'release'), 'JAVA_VERSION="21.0.9"\n']]);
  const directories = new Map([
    [SDK, ['platforms', 'build-tools', 'platform-tools', 'emulator', 'system-images']],
    [join(SDK, 'platforms', 'android-36'), []],
    [join(SDK, 'build-tools'), ['35.0.0', '36.0.0']],
    [join(SDK, 'build-tools', '36.0.0'), []],
    [join(SDK, 'platform-tools'), []],
    [join(SDK, 'emulator'), []],
    [IMAGE, []],
  ]);
  const accesses = [];
  const reads = [];
  const fs = {
    existsSync(path) {
      accesses.push(path);
      return files.has(path) || directories.has(path);
    },
    readFileSync(path, encoding) {
      accesses.push(path);
      reads.push(path);
      assert.equal(encoding, 'utf8');
      assert.ok(files.has(path), `Unexpected file read: ${path}`);
      return files.get(path);
    },
    readdirSync(path) {
      accesses.push(path);
      if (!directories.has(path)) throw new Error('Not a directory');
      return directories.get(path);
    },
  };
  const options = {
    env: { JAVA_HOME: JAVA, ANDROID_HOME: SDK },
    fs,
    homedir: HOME,
    nodeVersion: '22.12.0',
  };
  return { files, directories, accesses, reads, options, check: () => checkAll(options) };
}

function item(report, id) {
  const result = report.items.find((entry) => entry.id === id);
  assert.ok(result, `Missing report item: ${id}`);
  return result;
}

test('all requirements present yields an OK report and a readable CLI report with exit 0', () => {
  const fake = fixture();
  const report = fake.check();
  assert.equal(report.ok, true);
  assert.equal(report.items.length, 8);
  assert.ok(report.items.every((entry) => entry.ok && entry.message));
  const logs = [];
  assert.equal(
    main(fake.options, (line) => logs.push(line)),
    0,
  );
  assert.match(logs.join('\n'), /Android tooling doctor/);
  assert.equal(logs.filter((line) => line.startsWith('[OK]')).length, 8);
  assert.deepEqual(fake.reads, [join(JAVA, 'release'), join(JAVA, 'release')]);
});

test('each missing required item has a message, fails the report and returns exit 1', () => {
  for (const [id, remove] of [
    ['jdk21', (fake) => fake.files.delete(join(JAVA, 'release'))],
    [
      'android-sdk',
      (fake) => {
        delete fake.options.env.ANDROID_HOME;
      },
    ],
    [
      'android-platform-36',
      (fake) => fake.directories.delete(join(SDK, 'platforms', 'android-36')),
    ],
    [
      'android-build-tools-36',
      (fake) => fake.directories.delete(join(SDK, 'build-tools', '36.0.0')),
    ],
    ['android-platform-tools', (fake) => fake.directories.delete(join(SDK, 'platform-tools'))],
    [
      'node',
      (fake) => {
        fake.options.nodeVersion = '22.11.0';
      },
    ],
  ]) {
    const fake = fixture();
    remove(fake);
    const report = fake.check();
    assert.equal(report.ok, false, id);
    assert.equal(item(report, id).ok, false, id);
    assert.equal(item(report, id).required, true, id);
    assert.ok(item(report, id).message.length > 0, id);
    const logs = [];
    assert.equal(
      main(fake.options, (line) => logs.push(line)),
      1,
      id,
    );
    assert.ok(logs.includes(`[FAIL] ${item(report, id).message}`), id);
  }
});

test('missing emulator or system image only warns and never fails required checks', () => {
  const fake = fixture();
  fake.directories.delete(join(SDK, 'emulator'));
  fake.directories.delete(IMAGE);
  const report = fake.check();
  assert.equal(report.ok, true);
  for (const id of ['android-emulator', 'android-system-image']) {
    assert.equal(item(report, id).ok, false);
    assert.equal(item(report, id).required, false);
  }
  const logs = [];
  assert.equal(
    main(fake.options, (line) => logs.push(line)),
    0,
  );
  assert.equal(logs.filter((line) => line.startsWith('[WARN]')).length, 2);
});

test('finds JDK 21 in comma-separated Gradle installations.paths despite a newer JAVA_HOME', () => {
  const fake = fixture();
  fake.files.set(join(JAVA, 'release'), 'JAVA_VERSION="27.0.1"\n');
  const older = join('fixture', 'jdk17');
  const compatible = join('fixture', 'jdk21');
  fake.files.set(join(older, 'release'), 'JAVA_VERSION="17.0.9"\n');
  fake.files.set(join(compatible, 'release'), 'JAVA_VERSION="21.0.8+9"\n');
  const gradleHome = join('fixture', 'gradle-user');
  fake.options.env.GRADLE_USER_HOME = gradleHome;
  const properties = join(gradleHome, 'gradle.properties');
  fake.files.set(properties, `org.gradle.java.installations.paths= ${older}, ${compatible}\n`);
  assert.equal(fake.check().ok, true);
  assert.deepEqual(fake.reads, [
    join(JAVA, 'release'),
    properties,
    join(older, 'release'),
    join(compatible, 'release'),
  ]);
  assert.ok(!fake.accesses.includes(PROPERTIES), 'GRADLE_USER_HOME overrides the default home');
});

test('finds JDK 21 via org.gradle.java.home and decodes Java properties path escapes', () => {
  const fake = fixture();
  delete fake.options.env.JAVA_HOME;
  const compatible = join('fixture', 'JDK 21');
  fake.files.set(join(compatible, 'release'), 'JAVA_VERSION="21"\n');
  const escaped = compatible.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ');
  fake.files.set(PROPERTIES, `org.gradle.java.home : ${escaped}\n`);
  assert.equal(fake.check().ok, true);
  assert.deepEqual(fake.reads, [PROPERTIES, join(compatible, 'release')]);
});

test('JDK 17, 27, unrelated properties and a missing release do not satisfy JDK 21', () => {
  for (const version of ['17.0.9', '27', '210.0.1']) {
    const fake = fixture();
    fake.files.set(join(JAVA, 'release'), `JAVA_VERSION="${version}"\n`);
    fake.files.set(PROPERTIES, 'org.gradle.java.installations.paths.extra=fixture/ignored\n');
    const report = fake.check();
    assert.equal(report.ok, false, version);
    assert.equal(item(report, 'jdk21').ok, false, version);
    assert.match(item(report, 'jdk21').message, /JDK 21 missing/);
    assert.ok(!fake.accesses.some((path) => path.includes('ignored')));
  }
  const fake = fixture();
  delete fake.options.env.JAVA_HOME;
  assert.equal(fake.check().ok, false);
});

test('accepts ANDROID_SDK_ROOT, including when ANDROID_HOME is invalid, but not files as directories', () => {
  const fake = fixture();
  delete fake.options.env.ANDROID_HOME;
  fake.options.env.ANDROID_SDK_ROOT = SDK;
  assert.equal(fake.check().ok, true);
  fake.options.env.ANDROID_HOME = join('fixture', 'absent-sdk');
  assert.equal(fake.check().ok, true);
  fake.directories.delete(join(SDK, 'platform-tools'));
  fake.files.set(join(SDK, 'platform-tools'), 'not a directory');
  assert.equal(item(fake.check(), 'android-platform-tools').ok, false);
  fake.directories.delete(SDK);
  assert.equal(item(fake.check(), 'android-sdk').ok, false);
});

test('requires a 36.* build-tools directory, not an older release or an ordinary file', () => {
  const fake = fixture();
  fake.directories.delete(join(SDK, 'build-tools', '36.0.0'));
  fake.files.set(join(SDK, 'build-tools', '36.0.0'), 'not a directory');
  assert.equal(item(fake.check(), 'android-build-tools-36').ok, false);
  fake.directories.set(join(SDK, 'build-tools'), ['35.0.0', '36.1.2']);
  fake.directories.set(join(SDK, 'build-tools', '36.1.2'), []);
  assert.equal(item(fake.check(), 'android-build-tools-36').ok, true);
  fake.directories.delete(join(SDK, 'build-tools'));
  assert.equal(item(fake.check(), 'android-build-tools-36').ok, false);
});

test('enforces the Node 22.12 boundary and accepts newer major releases', () => {
  const fake = fixture();
  for (const version of ['22.12', '22.12.0', '22.20.0', '23.0.0', '24.0.0', 'v24.1.0']) {
    fake.options.nodeVersion = version;
    assert.equal(fake.check().ok, true, version);
  }
  for (const version of ['20.19.0', '21.99.0', '22.11.99', 'invalid']) {
    fake.options.nodeVersion = version;
    assert.equal(item(fake.check(), 'node').ok, false, version);
  }
});

test('never inspects environment files, keystores or unrelated Gradle properties, or prints values', () => {
  const fake = fixture();
  delete fake.options.env.JAVA_HOME;
  const unrelated = 'fixture-unrelated-secret-value';
  fake.files.set(
    PROPERTIES,
    [
      `signing.password=${unrelated}`,
      'signing.storeFile=fixture/private.jks',
      'org.gradle.project.envFile=fixture/.env',
      `org.gradle.java.home=${JAVA}`,
    ].join('\n'),
  );
  const logs = [];
  assert.equal(
    main(fake.options, (line) => logs.push(line)),
    0,
  );
  assert.deepEqual(fake.reads, [PROPERTIES, join(JAVA, 'release')]);
  const allowed = new Set([PROPERTIES, join(JAVA, 'release'), ...fake.directories.keys()]);
  assert.ok(fake.accesses.every((path) => allowed.has(path)));
  assert.ok(fake.accesses.every((path) => !/\.env|\.jks|keystore/i.test(path)));
  assert.ok(!logs.join('\n').includes(unrelated));
  assert.ok(!logs.join('\n').includes(JAVA));
});

test('unreadable JDK release or Gradle properties fails cleanly without exposing their contents', () => {
  for (const denied of [join(JAVA, 'release'), PROPERTIES]) {
    const fake = fixture();
    if (denied === PROPERTIES) {
      delete fake.options.env.JAVA_HOME;
      fake.files.set(PROPERTIES, `org.gradle.java.home=${JAVA}`);
    }
    const read = fake.options.fs.readFileSync;
    fake.options.fs.readFileSync = (path, encoding) => {
      if (path === denied) throw new Error('fixture permission denied');
      return read(path, encoding);
    };
    assert.equal(fake.check().ok, false);
  }
});
