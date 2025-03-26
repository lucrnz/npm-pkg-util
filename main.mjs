#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';

/**
 * @typedef {Object} PackageInfo
 * @property {string} pkgPath - Path to the package in the packages object
 * @property {Object} pkgInfo - Package information from package-lock.json
 */

/**
 * @typedef {Object} CommandOptions
 * @property {boolean} dry - Whether to run in dry mode
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create a new command program
const program = new Command();

program
  .name('npm-pkg-util')
  .description('CLI to update package-lock.json with specific missing entries')
  .version('1.0.0');

program
  .command('add')
  .description('Add a specific package to package-lock.json')
  .argument('<package>', 'Package to add (format: package@version)')
  .option(
    '-d, --dry',
    'Run in dry mode, only update temporary files without replacing package-lock.json',
    false,
  )
  .action(async (packageArg, options) => {
    try {
      // Check npm version
      const npmVersion = await checkNpmVersion();
      const majorVersion = Number.parseInt(npmVersion.split('.')[0], 10);

      if (majorVersion < 7) {
        console.error(
          chalk.red(
            `Error: This tool requires npm v7 or higher. You are using npm v${npmVersion}`,
          ),
        );
        process.exit(1);
      }

      const cwd = process.cwd();
      const packageLockPath = path.join(cwd, 'package-lock.json');
      const packageJsonPath = path.join(cwd, 'package.json');

      // Check if package-lock.json and package.json exist
      if (!fsSync.existsSync(packageLockPath)) {
        console.error(chalk.red('Error: package-lock.json not found'));
        process.exit(1);
      }

      if (!fsSync.existsSync(packageJsonPath)) {
        console.error(chalk.red('Error: package.json not found'));
        process.exit(1);
      }

      // Parse package argument (name@version)

      /** @type {string|undefined} */
      let packageName;

      /** @type {string|undefined} */
      let packageVersion;

      if (packageArg.startsWith('@')) {
        // Handle namespaced packages (@namespace/pkg@version)
        const lastAtIndex = packageArg.lastIndexOf('@');
        if (lastAtIndex > 0) {
          packageName = packageArg.substring(0, lastAtIndex);
          packageVersion = packageArg.substring(lastAtIndex + 1);
        } else {
          packageName = packageArg;
          packageVersion = '';
        }
      } else {
        // Handle regular packages (pkg@version)
        [packageName, packageVersion] = packageArg.split('@');
      }

      if (!packageName) {
        console.error(
          chalk.red(
            'Error: Invalid package format. Use package@version or @namespace/package@version',
          ),
        );
        process.exit(1);
      }

      // Create temporary directory
      const tempDir = path.join(cwd, '.pkg-util-temp');
      try {
        await fs.mkdir(tempDir, { recursive: true });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }

      try {
        // Copy package.json and package-lock.json to temp directory
        await fs.copyFile(packageJsonPath, path.join(tempDir, 'package.json'));
        await fs.copyFile(
          packageLockPath,
          path.join(tempDir, 'package-lock.json'),
        );

        console.log(
          chalk.blue(
            `Adding ${packageName}${packageVersion ? `@${packageVersion}` : ''} to package-lock.json...`,
          ),
        );

        // Run npm install for the specified package
        const versionString = packageVersion ? `@${packageVersion}` : '';
        const packageString = `${packageName}${versionString}`;

        // Use npm programmatically to install the package
        await new Promise((resolve, reject) => {
          const npmProcess = spawn(
            'npm',
            ['install', packageString, '--package-lock-only'],
            {
              cwd: tempDir,
              stdio: 'inherit',
            },
          );

          npmProcess.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`npm install failed with code ${code}`));
            }
          });
        });

        // Read the updated package-lock.json
        const updatedPackageLock = JSON.parse(
          await fs.readFile(path.join(tempDir, 'package-lock.json'), 'utf8'),
        );
        const originalPackageLock = JSON.parse(
          await fs.readFile(packageLockPath, 'utf8'),
        );

        // Get the dependency information for the specified package
        const packageInfo = getPackageInfoFromLock(
          updatedPackageLock,
          packageName,
        );

        if (!packageInfo) {
          console.error(
            chalk.red(
              `Error: Could not find ${packageName} in the updated package-lock.json`,
            ),
          );
          process.exit(1);
        }

        // Merge the package information into the original package-lock.json
        const mergedPackageLock = mergePackageIntoLock(
          originalPackageLock,
          packageName,
          packageInfo,
          updatedPackageLock,
        );

        if (options.dry) {
          console.log(
            chalk.yellow('Dry run mode. Not updating package-lock.json'),
          );
          console.log(
            chalk.green(
              `Successfully resolved ${packageName}${packageVersion ? `@${packageVersion}` : ''}`,
            ),
          );
        } else {
          // Write the merged package-lock.json back to the original location
          await fs.writeFile(
            packageLockPath,
            JSON.stringify(mergedPackageLock, null, 2),
          );
          console.log(
            chalk.green(
              `Successfully added ${packageName}${packageVersion ? `@${packageVersion}` : ''} to package-lock.json`,
            ),
          );
        }
      } finally {
        // Clean up temporary directory
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

/**
 * @param {Object} packageLock - The package-lock.json object
 * @param {string} packageName - The name of the package to find
 * @returns {PackageInfo|null} - Package information or null if not found
 */
function getPackageInfoFromLock(packageLock, packageName) {
  // For npm v7+ (with "packages" structure)
  if (packageLock.packages) {
    // Check in dependencies
    for (const [pkgPath, pkgInfo] of Object.entries(packageLock.packages)) {
      if (pkgPath === `node_modules/${packageName}` || pkgPath === '') {
        return { pkgPath, pkgInfo };
      }
    }
  }

  return null;
}

/**
 * @param {Object} originalLock - The original package-lock.json object
 * @param {string} packageName - The name of the package to merge
 * @param {PackageInfo} packageInfo - The package information to merge
 * @param {Object} updatedLock - The updated package-lock.json object
 * @returns {Object} - The merged package-lock.json object
 */
function mergePackageIntoLock(
  originalLock,
  packageName,
  packageInfo,
  updatedLock,
) {
  // Create a deep copy of the original package-lock.json
  const result = JSON.parse(JSON.stringify(originalLock));

  // Set package info
  if (packageInfo.pkgPath) {
    result.packages[packageInfo.pkgPath] = packageInfo.pkgInfo;
  }

  // Also copy any nested dependencies that might have been added
  for (const [pkgPath, pkgInfo] of Object.entries(updatedLock.packages)) {
    if (
      pkgPath.startsWith(`node_modules/${packageName}/`) &&
      !result.packages[pkgPath]
    ) {
      result.packages[pkgPath] = pkgInfo;
    }
  }

  return result;
}

/**
 * @returns {Promise<string>} - The npm version string
 */
async function checkNpmVersion() {
  return new Promise((resolve, reject) => {
    const npmProcess = spawn('npm', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let version = '';

    npmProcess.stdout.on('data', (data) => {
      version += data.toString().trim();
    });

    npmProcess.on('close', (code) => {
      if (code === 0) {
        resolve(version);
      } else {
        reject(new Error('Failed to get npm version'));
      }
    });
  });
}

program.parse();
