/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import admZip from 'adm-zip'
import * as vscode from 'vscode'
import path from 'path'
import { tempDirPath } from '../../shared/filesystemUtilities'
import { getLogger } from '../../shared/logger'
import * as CodeWhispererConstants from '../models/constants'
import { ToolkitError } from '../../shared/errors'
import { fs } from '../../shared/fs/fs'
import { getLoggerForScope } from '../service/securityScanHandler'
import { runtimeLanguageContext } from './runtimeLanguageContext'
import { CodewhispererLanguage } from '../../shared/telemetry/telemetry.gen'
import { CurrentWsFolders, collectFiles } from '../../shared/utilities/workspaceUtils'
import { FileSizeExceededError, NoSourceFilesError, ProjectSizeExceededError } from '../models/errors'

export interface ZipMetadata {
    rootDir: string
    zipFilePath: string
    scannedFiles: Set<string>
    srcPayloadSizeInBytes: number
    buildPayloadSizeInBytes: number
    zipFileSizeInBytes: number
    lines: number
    language: CodewhispererLanguage | undefined
}

export const ZipConstants = {
    newlineRegex: /\r?\n/,
    gitignoreFilename: '.gitignore',
    knownBinaryFileExts: ['.class'],
}

export class ZipUtil {
    protected _pickedSourceFiles: Set<string> = new Set<string>()
    protected _pickedBuildFiles: Set<string> = new Set<string>()
    protected _totalSize: number = 0
    protected _totalBuildSize: number = 0
    protected _tmpDir: string = tempDirPath
    protected _zipDir: string = ''
    protected _totalLines: number = 0
    protected _fetchedDirs: Set<string> = new Set<string>()
    protected _language: CodewhispererLanguage | undefined

    constructor() {}

    getFileScanPayloadSizeLimitInBytes(): number {
        return CodeWhispererConstants.fileScanPayloadSizeLimitBytes
    }

    getProjectScanPayloadSizeLimitInBytes(): number {
        return CodeWhispererConstants.projectScanPayloadSizeLimitBytes
    }

    public getProjectPaths() {
        const workspaceFolders = vscode.workspace.workspaceFolders
        return workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
    }

    protected async getTextContent(uri: vscode.Uri) {
        const document = await vscode.workspace.openTextDocument(uri)
        const content = document.getText()
        return content
    }

    public reachSizeLimit(size: number, scope: CodeWhispererConstants.CodeAnalysisScope): boolean {
        if (scope === CodeWhispererConstants.CodeAnalysisScope.FILE) {
            return size > this.getFileScanPayloadSizeLimitInBytes()
        } else {
            return size > this.getProjectScanPayloadSizeLimitInBytes()
        }
    }

    public willReachSizeLimit(current: number, adding: number): boolean {
        const willReachLimit = current + adding > this.getProjectScanPayloadSizeLimitInBytes()
        return willReachLimit
    }

    protected async zipFile(uri: vscode.Uri | undefined) {
        if (!uri) {
            throw Error('Uri is undefined')
        }
        const zip = new admZip()

        const content = await this.getTextContent(uri)

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
        if (workspaceFolder) {
            const projectName = workspaceFolder.name
            const relativePath = vscode.workspace.asRelativePath(uri)
            const zipEntryPath = this.getZipEntryPath(projectName, relativePath)
            zip.addFile(zipEntryPath, Buffer.from(content, 'utf-8'))
        } else {
            zip.addFile(uri.fsPath, Buffer.from(content, 'utf-8'))
        }

        this._pickedSourceFiles.add(uri.fsPath)
        this._totalSize += (await fs.stat(uri.fsPath)).size
        this._totalLines += content.split(ZipConstants.newlineRegex).length

        if (this.reachSizeLimit(this._totalSize, CodeWhispererConstants.CodeAnalysisScope.FILE)) {
            throw new FileSizeExceededError()
        }

        const zipFilePath = this.getZipDirPath() + CodeWhispererConstants.codeScanZipExt
        zip.writeZip(zipFilePath)
        return zipFilePath
    }

    protected getZipEntryPath(projectName: string, relativePath: string) {
        // Workspaces with multiple folders have the folder names as the root folder,
        // but workspaces with only a single folder don't. So prepend the workspace folder name
        // if it is not present.
        return relativePath.split('/').shift() === projectName ? relativePath : path.join(projectName, relativePath)
    }

    protected async zipProject() {
        const zip = new admZip()

        const projectPaths = this.getProjectPaths()
        const languageCount = new Map<CodewhispererLanguage, number>()

        await this.processSourceFiles(zip, languageCount, projectPaths)
        this.processOtherFiles(zip, languageCount)

        if (languageCount.size === 0) {
            throw new NoSourceFilesError()
        }
        this._language = [...languageCount.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
        const zipFilePath = this.getZipDirPath() + CodeWhispererConstants.codeScanZipExt
        zip.writeZip(zipFilePath)
        return zipFilePath
    }

    protected async processSourceFiles(
        zip: admZip,
        languageCount: Map<CodewhispererLanguage, number>,
        projectPaths: string[] | undefined
    ) {
        if (!projectPaths || projectPaths.length === 0) {
            return
        }

        const sourceFiles = await collectFiles(
            projectPaths,
            vscode.workspace.workspaceFolders as CurrentWsFolders,
            true,
            this.getProjectScanPayloadSizeLimitInBytes()
        )
        for (const file of sourceFiles) {
            const zipEntryPath = this.getZipEntryPath(file.workspaceFolder.name, file.zipFilePath)

            if (ZipConstants.knownBinaryFileExts.includes(path.extname(file.fileUri.fsPath))) {
                await this.processBinaryFile(zip, file.fileUri, zipEntryPath)
            } else {
                const isFileOpenAndDirty = this.isFileOpenAndDirty(file.fileUri)
                const fileContent = isFileOpenAndDirty ? await this.getTextContent(file.fileUri) : file.fileContent
                this.processTextFile(zip, file.fileUri, fileContent, languageCount, zipEntryPath)
            }
        }
    }

    protected processOtherFiles(zip: admZip, languageCount: Map<CodewhispererLanguage, number>) {
        vscode.workspace.textDocuments
            .filter((document) => document.uri.scheme === 'file')
            .filter((document) => vscode.workspace.getWorkspaceFolder(document.uri) === undefined)
            .forEach((document) =>
                this.processTextFile(zip, document.uri, document.getText(), languageCount, document.uri.fsPath)
            )
    }

    protected processTextFile(
        zip: admZip,
        uri: vscode.Uri,
        fileContent: string,
        languageCount: Map<CodewhispererLanguage, number>,
        zipEntryPath: string
    ) {
        const fileSize = Buffer.from(fileContent).length

        if (
            this.reachSizeLimit(this._totalSize, CodeWhispererConstants.CodeAnalysisScope.PROJECT) ||
            this.willReachSizeLimit(this._totalSize, fileSize)
        ) {
            throw new ProjectSizeExceededError()
        }
        this._pickedSourceFiles.add(uri.fsPath)
        this._totalSize += fileSize
        this._totalLines += fileContent.split(ZipConstants.newlineRegex).length

        this.incrementCountForLanguage(uri, languageCount)
        zip.addFile(zipEntryPath, Buffer.from(fileContent, 'utf-8'))
    }

    protected async processBinaryFile(zip: admZip, uri: vscode.Uri, zipEntryPath: string) {
        const fileSize = (await fs.stat(uri.fsPath)).size

        if (
            this.reachSizeLimit(this._totalSize, CodeWhispererConstants.CodeAnalysisScope.PROJECT) ||
            this.willReachSizeLimit(this._totalSize, fileSize)
        ) {
            throw new ProjectSizeExceededError()
        }
        this._pickedSourceFiles.add(uri.fsPath)
        this._totalSize += fileSize

        zip.addLocalFile(uri.fsPath, path.dirname(zipEntryPath))
    }

    protected incrementCountForLanguage(uri: vscode.Uri, languageCount: Map<CodewhispererLanguage, number>) {
        const fileExtension = path.extname(uri.fsPath).slice(1)
        const language = runtimeLanguageContext.getLanguageFromFileExtension(fileExtension)
        if (language && language !== 'plaintext') {
            languageCount.set(language, (languageCount.get(language) || 0) + 1)
        }
    }

    protected isFileOpenAndDirty(uri: vscode.Uri) {
        return vscode.workspace.textDocuments.some((document) => document.uri.fsPath === uri.fsPath && document.isDirty)
    }

    protected getZipDirPath(): string {
        if (this._zipDir === '') {
            this._zipDir = path.join(
                this._tmpDir,
                CodeWhispererConstants.codeScanTruncDirPrefix + '_' + Date.now().toString()
            )
        }
        return this._zipDir
    }

    public async generateZip(
        uri: vscode.Uri | undefined,
        scope: CodeWhispererConstants.CodeAnalysisScope
    ): Promise<ZipMetadata> {
        try {
            const zipDirPath = this.getZipDirPath()
            let zipFilePath: string
            if (scope === CodeWhispererConstants.CodeAnalysisScope.FILE) {
                zipFilePath = await this.zipFile(uri)
            } else if (scope === CodeWhispererConstants.CodeAnalysisScope.PROJECT) {
                zipFilePath = await this.zipProject()
            } else {
                throw new ToolkitError(`Unknown code analysis scope: ${scope}`)
            }

            getLoggerForScope(scope).debug(`Picked source files: [${[...this._pickedSourceFiles].join(', ')}]`)
            const zipFileSize = (await fs.stat(zipFilePath)).size
            return {
                rootDir: zipDirPath,
                zipFilePath: zipFilePath,
                srcPayloadSizeInBytes: this._totalSize,
                scannedFiles: new Set([...this._pickedSourceFiles, ...this._pickedBuildFiles]),
                zipFileSizeInBytes: zipFileSize,
                buildPayloadSizeInBytes: this._totalBuildSize,
                lines: this._totalLines,
                language: this._language,
            }
        } catch (error) {
            getLogger().error('Zip error caused by: %O', error)
            throw error
        }
    }

    public async removeTmpFiles(zipMetadata: ZipMetadata, scope: CodeWhispererConstants.CodeAnalysisScope) {
        const logger = getLoggerForScope(scope)
        logger.verbose(`Cleaning up temporary files...`)
        await fs.delete(zipMetadata.zipFilePath, { force: true })
        await fs.delete(zipMetadata.rootDir, { recursive: true, force: true })
        logger.verbose(`Complete cleaning up temporary files.`)
    }
}
