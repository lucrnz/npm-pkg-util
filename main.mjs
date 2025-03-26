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
  .description('Add specific packages to package-lock.json')
  .argument('<packages...>', 'Packages to add (format: package@version)')
  .option(
    '-d, --dry',
    'Run in dry mode, only update temporary files without replacing package-lock.json',
    false,
  )
  .action(async (packageArgs, options) => {
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

        // Handle .npmrc file if it exists
        const npmrcPath = path.join(cwd, '.npmrc');
        if (fsSync.existsSync(npmrcPath)) {
          try {
            // Read the contents of .npmrc (handles symlinks)
            const npmrcContents = await fs.readFile(npmrcPath, 'utf8');
            // Write the contents to the temp directory
            await fs.writeFile(path.join(tempDir, '.npmrc'), npmrcContents);
          } catch (error) {
            console.error(
              chalk.yellow(
                `Warning: Failed to copy .npmrc file: ${error.message}`,
              ),
            );
          }
        }

        let currentPackageLock = JSON.parse(
          await fs.readFile(packageLockPath, 'utf8'),
        );

        // Process each package sequentially
        for (const packageArg of packageArgs) {
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
                `Error: Invalid package format for "${packageArg}". Use package@version or @namespace/package@version`,
              ),
            );
            process.exit(1);
          }

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

          // Merge the package information into the current package-lock.json
          currentPackageLock = mergePackageIntoLock(
            currentPackageLock,
            packageName,
            packageInfo,
            updatedPackageLock,
          );

          // Write back the intermediate result to the temp directory
          await fs.writeFile(
            path.join(tempDir, 'package-lock.json'),
            JSON.stringify(currentPackageLock, null, 2),
          );
        }

        if (options.dry) {
          console.log(
            chalk.yellow('Dry run mode. Not updating package-lock.json'),
          );
          console.log(chalk.green('Successfully resolved all packages'));
        } else {
          // Write the final merged package-lock.json back to the original location
          await fs.writeFile(
            packageLockPath,
            JSON.stringify(currentPackageLock, null, 2),
          );
          console.log(
            chalk.green('Successfully added all packages to package-lock.json'),
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

  // Ensure we have the packages object
  if (!result.packages) {
    result.packages = {};
  }

  // Copy all new or updated packages from the updated lock
  for (const [pkgPath, pkgInfo] of Object.entries(updatedLock.packages)) {
    // Copy if:
    // 1. It's the root package
    // 2. It's the target package
    // 3. It's a dependency of the target package
    // 4. It's a new package that didn't exist before
    if (
      pkgPath === '' || // root package
      pkgPath === `node_modules/${packageName}` || // target package
      pkgPath.startsWith(`node_modules/${packageName}/`) || // direct dependency
      !result.packages[pkgPath] // new package
    ) {
      result.packages[pkgPath] = pkgInfo;
    }
  }

  // Copy other important fields from the updated lock if they exist
  const fieldsToMerge = ['dependencies', 'lockfileVersion'];
  for (const field of fieldsToMerge) {
    if (updatedLock[field] && !result[field]) {
      result[field] = updatedLock[field];
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
