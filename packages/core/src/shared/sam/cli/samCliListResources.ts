/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { logAndThrowIfUnexpectedExitCode, SamCliProcessInvoker } from './samCliInvokerUtils'

export interface SamCliListResourcesParameters {
    templateFile: string
    stackName: string
    region?: string
}

export async function runSamCliListResource(
    listStackResourcesArguments: SamCliListResourcesParameters,
    invoker: SamCliProcessInvoker
): Promise<any> {
    const args = [
        'list',
        'resources',
        '--template-file',
        listStackResourcesArguments.templateFile,
        '--stack-name',
        listStackResourcesArguments.stackName,
        '--output',
        'json',
    ]

    if (listStackResourcesArguments.region) {
        args.push('--region', listStackResourcesArguments.region)
    }

    try {
        const childProcessResult = await invoker.invoke({
            arguments: args,
            spawnOptions: {},
        })

        logAndThrowIfUnexpectedExitCode(childProcessResult, 0)

        return childProcessResult.stdout
    } catch (error: any) {
        void vscode.window.showErrorMessage(`Failed to run SAM CLI list resources: ${error.message}`)
        return []
    }
}
