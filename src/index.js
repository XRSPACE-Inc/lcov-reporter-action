import { promises as fs } from "fs"
import core from "@actions/core"
import { getOctokit, context } from "@actions/github"
import path from "path"

import { parse } from "./lcov"
import { diff } from "./comment"
import { getChangedFiles } from "./get_changes"
import { deleteOldComments } from "./delete_old_comments"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = 65536
const MAX_JOB_SUMMARY_CHARS = 1000 * 1024

async function main() {
	const token = core.getInput("github-token")
	const octokit = getOctokit(token)
	const githubClient = octokit.rest
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const saveFile = path.join(
		workingDir,
		core.getInput("save-file") || "./coverage/coverage-report.md",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const postTo = core.getInput("post-to").toLowerCase()
	const title = core.getInput("title")

	const raw = await fs.readFile(lcovFile, "utf-8").catch(err => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch(err => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: context.payload.repository.full_name,
		prefix: normalisePath(path.join(workingDir).replace(/\.\/(.*)/, '$1')),
		workingDir,
	}

	if (
		context.eventName === "pull_request" ||
		context.eventName === "pull_request_target"
	) {
		options.commit = context.payload.pull_request.head.sha
		options.baseCommit = context.payload.pull_request.base.sha
		options.head = context.payload.pull_request.head.ref
		options.base = context.payload.pull_request.base.ref
	} else if (context.eventName === "push") {
		options.commit = context.payload.after
		options.baseCommit = context.payload.before
		options.head = context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const body = diff(lcov, baselcov, options)

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, context)
	}

	switch (postTo) {
		case "comment": {
			const strippedBody = body.substring(0, MAX_COMMENT_CHARS)
			if (
				context.eventName === "pull_request" ||
				context.eventName === "pull_request_target"
			) {
				await githubClient.issues.createComment({
					repo: context.repo.repo,
					owner: context.repo.owner,
					issue_number: context.payload.pull_request.number,
					body: strippedBody,
				})
			} else if (context.eventName === "push") {
				await githubClient.repos.createCommitComment({
					repo: context.repo.repo,
					owner: context.repo.owner,
					commit_sha: options.commit,
					body: strippedBody,
				})
			}
			break
		}
		case "job-summary": {
			const strippedBody = body.substring(0, MAX_JOB_SUMMARY_CHARS)
			core.summary.addRaw(strippedBody)
			await core.summary.write()
			break
		}
		case "file": {
			await fs.writeFile(saveFile, body)
			break
		}
		default:
			core.warning(`Unknown post-to value: '${postTo}'`)
	}
}

main().catch(function(err) {
	console.log(err)
	core.setFailed(err.message)
})
