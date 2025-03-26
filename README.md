# npm-pkg-util

A CLI tool to update package-lock.json files by adding specific missing entries without regenerating the entire lock file.

## Problem Solved

This tool addresses the common issue where CI pipelines fail because certain packages are missing from the `package-lock.json` file, but you don't want to regenerate the entire lock file using `npm i` (which might update many other dependencies).

## Disclaimer

This application is currently in testing and was developed to solve the tool author's specific problems.

It may fail and **SHOULD NOT BE USED IN PRODUCTION WITHOUT DOUBLE-CHECKING EVERYTHING IS WORKING**.

The author does not prioritize issue reports; instead, please send pull requests, and they might be reviewed.

## Installation

### Local Installation

```bash
npm install -g .
```

### Development Setup

```bash
git clone https://github.com/lucrnz/npm-pkg-util.git
cd npm-pkg-util
npm install
npm link
```

## Usage

```bash
# Add a specific package to package-lock.json
npm-pkg-util add package-name@version

# Example: Add auth package version 3.0.3
npm-pkg-util add auth@3.0.3

# Dry run (doesn't update the actual package-lock.json)
npm-pkg-util add auth@3.0.3 --dry
```

## How It Works

1. Creates a temporary directory
2. Copies your current package.json and package-lock.json to the temp directory
3. Runs `npm install package-name@version --package-lock-only` in the temp directory
4. Extracts just the relevant information for the specified package from the updated package-lock.json
5. Merges this information into your original package-lock.json
6. Cleans up the temporary directory

## Options

- `-d, --dry`: Run in dry mode (doesn't update the actual package-lock.json)
- `-h, --help`: Display help for command

## Requirements

- Node.js 14 or higher
- npm 7 or higher (not compatible with npm v6)

## License

MIT