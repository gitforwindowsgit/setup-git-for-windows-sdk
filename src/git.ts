import * as core from '@actions/core'
import {ChildProcess, spawn} from 'child_process'
import {Octokit} from '@octokit/rest'
import {delimiter} from 'path'
import * as fs from 'fs'
import os from 'os'
import fetch, {RequestInit} from 'node-fetch'

// If present, do prefer the build agent's copy of Git
const externalsGitDir = `${process.env.AGENT_HOMEDIRECTORY}/externals/git`
const gitForWindowsRoot = 'C:/Program Files/Git'
const gitRoot = fs.existsSync(externalsGitDir)
  ? externalsGitDir
  : gitForWindowsRoot

const gitForWindowsBinPaths = ['clangarm64', 'mingw64', 'mingw32', 'usr'].map(
  p => `${gitRoot}/${p}/bin`
)
export const gitForWindowsUsrBinPath =
  gitForWindowsBinPaths[gitForWindowsBinPaths.length - 1]
const gitExePath = `${gitRoot}/cmd/git.exe`

/*
 * It looks a bit ridiculous to use 56 workers on a build agent that has only
 * a two-core CPU, yet manual testing revealed that 64 workers would be _even
 * better_. But at 92 workers, resources are starved so much that the checkout
 * is not only much faster, but also fails.
 *
 * Let's stick with 56, which should avoid running out of resources, but still
 * is much faster than, say, using only 2 workers.
 */
const GIT_CONFIG_PARAMETERS = `'checkout.workers=56'`

export function getArtifactMetadata(
  flavor: string,
  architecture: string
): {repo: string; artifactName: string} {
  const repo = {
    i686: 'git-sdk-32',
    x86_64: 'git-sdk-64',
    aarch64: 'git-sdk-arm64'
  }[architecture]

  if (repo === undefined) {
    throw new Error(`Invalid architecture ${architecture} specified`)
  }

  const artifactName = `${repo}-${flavor}`

  return {repo, artifactName}
}

async function clone(
  url: string,
  destination: string,
  verbose: number | boolean,
  cloneExtraOptions: string[] = []
): Promise<void> {
  if (verbose) core.info(`Cloning ${url} to ${destination}`)
  const child = spawn(
    gitExePath,
    [
      'clone',
      '--depth=1',
      '--single-branch',
      '--branch=main',
      ...cloneExtraOptions,
      url,
      destination
    ],
    {
      env: {
        GIT_CONFIG_PARAMETERS
      },
      stdio: [undefined, 'inherit', 'inherit']
    }
  )
  return new Promise<void>((resolve, reject) => {
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`git clone: exited with code ${code}`))
      }
    })
  })
}

async function updateHEAD(
  bareRepositoryPath: string,
  headSHA: string
): Promise<void> {
  const child = spawn(
    gitExePath,
    ['--git-dir', bareRepositoryPath, 'update-ref', 'HEAD', headSHA],
    {
      env: {
        GIT_CONFIG_PARAMETERS
      },
      stdio: [undefined, 'inherit', 'inherit']
    }
  )
  return new Promise<void>((resolve, reject) => {
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`git: exited with code ${code}`))
      }
    })
  })
}

type GetViaGitResult = {
  artifactName: string
  id: string
  download: (
    outputDirectory: string,
    verbose?: number | boolean
  ) => Promise<void>
}

export async function getViaGit(
  flavor: string,
  architecture: string,
  githubToken?: string
): Promise<GetViaGitResult> {
  const owner = 'git-for-windows'

  const {repo, artifactName} = getArtifactMetadata(flavor, architecture)

  const octokit = githubToken ? new Octokit({auth: githubToken}) : new Octokit()

  if (flavor === 'minimal') {
    return getMinimalFlavor(owner, repo, artifactName, octokit, githubToken)
  }

  const info = await octokit.repos.getBranch({
    owner,
    repo,
    branch: 'main'
  })
  const head_sha = info.data.commit.sha
  const id = `${artifactName}-${head_sha}${head_sha === 'e37e3f44c1934f0f263dabbf4ed50a3cfb6eaf71' ? '-2' : ''}`
  core.info(`Got commit ${head_sha} for ${repo}`)

  return {
    artifactName,
    id,
    download: async (
      outputDirectory: string,
      verbose: number | boolean = false
    ): Promise<void> => {
      core.startGroup(`Cloning ${repo}`)
      const partialCloneArg = flavor === 'full' ? [] : ['--filter=blob:none']
      await clone(`https://github.com/${owner}/${repo}`, `.tmp`, verbose, [
        '--bare',
        ...partialCloneArg
      ])
      core.endGroup()

      let child: ChildProcess
      if (flavor === 'full') {
        core.startGroup(`Checking out ${repo}`)
        child = spawn(
          gitExePath,
          [`--git-dir=.tmp`, 'worktree', 'add', outputDirectory, head_sha],
          {
            env: {
              GIT_CONFIG_PARAMETERS
            },
            stdio: [undefined, 'inherit', 'inherit']
          }
        )
      } else {
        await updateHEAD('.tmp', head_sha)
        core.startGroup('Cloning build-extra')
        await clone(
          `https://github.com/${owner}/build-extra`,
          '.tmp/build-extra',
          verbose
        )
        core.endGroup()

        core.startGroup(`Creating ${flavor} artifact`)
        const traceArg = verbose ? ['-x'] : []
        child = spawn(
          `${gitForWindowsUsrBinPath}/bash.exe`,
          [
            ...traceArg,
            '.tmp/build-extra/please.sh',
            'create-sdk-artifact',
            `--architecture=${architecture}`,
            `--out=${outputDirectory}`,
            '--sdk=.tmp',
            flavor
          ],
          {
            env: {
              GIT_CONFIG_PARAMETERS,
              COMSPEC:
                process.env.COMSPEC ||
                `${process.env.WINDIR}\\system32\\cmd.exe`,
              LC_CTYPE: 'C.UTF-8',
              CHERE_INVOKING: '1',
              MSYSTEM: 'MINGW64',
              PATH: `${gitForWindowsBinPaths.join(delimiter)}${delimiter}${process.env.PATH}`
            },
            stdio: [undefined, 'inherit', 'inherit']
          }
        )
      }
      return new Promise<void>((resolve, reject) => {
        child.on('close', code => {
          core.endGroup()
          if (code === 0) {
            fs.rm('.tmp', {recursive: true}, () => resolve())
          } else {
            reject(new Error(`process exited with code ${code}`))
          }
        })
      })
    }
  }
}

async function getMinimalFlavor(
  owner: string,
  repo: string,
  artifactName: string,
  octokit: Octokit,
  githubToken?: string
): Promise<GetViaGitResult> {
  const ciArtifactsResponse = await octokit.repos.getReleaseByTag({
    owner,
    repo,
    tag: 'ci-artifacts'
  })

  if (ciArtifactsResponse.status !== 200) {
    throw new Error(
      `Failed to get ci-artifacts release from the ${owner}/${repo} repo: ${ciArtifactsResponse.status}`
    )
  }

  const tarGzArtifact = ciArtifactsResponse.data.assets.find(asset =>
    asset.name.endsWith('.tar.gz')
  )

  if (!tarGzArtifact) {
    throw new Error(
      `Failed to find a tar.gz artifact in the ci-artifacts release of the ${owner}/${repo} repo`
    )
  }

  return {
    artifactName,
    id: `ci-artifacts-${tarGzArtifact.updated_at}`,
    download: async (
      outputDirectory: string,
      verbose: number | boolean = false
    ): Promise<void> => {
      const tmpFile = `${os.tmpdir()}/${tarGzArtifact.name}`
      core.info(
        `Downloading ${tarGzArtifact.browser_download_url} to ${tmpFile}...`
      )
      await downloadFile(
        tarGzArtifact.browser_download_url,
        {
          headers: {
            ...(githubToken ? {Authorization: `Bearer ${githubToken}`} : {}),
            Accept: 'application/octet-stream'
          }
        },
        tmpFile
      )
      core.info(`Extracting ${tmpFile} to ${outputDirectory}...`)
      fs.mkdirSync(outputDirectory)
      const child = spawn(
        'C:\\Windows\\system32\\tar.exe',
        [`-xz${verbose ? 'v' : ''}f`, tmpFile, '-C', outputDirectory],
        {
          stdio: [undefined, 'inherit', 'inherit']
        }
      )
      return new Promise<void>((resolve, reject) => {
        child.on('close', code => {
          if (code === 0) {
            core.info('Finished extracting archive.')
            fs.rm(tmpFile, () => resolve())
          } else {
            reject(new Error(`tar -xzf process exited with code ${code}`))
          }
        })
      })
    }
  }
}

async function downloadFile(
  url: string,
  options: RequestInit,
  destination: string
): Promise<void> {
  const response = await fetch(url, options)

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`)
  }

  const fileStream = fs.createWriteStream(destination)
  response.body.pipe(fileStream)

  return new Promise((resolve, reject) => {
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
  })
}
