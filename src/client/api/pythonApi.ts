// eslint-disable-next-line
/* eslint-disable comma-dangle */
// eslint-disable-next-line
/* eslint-disable max-classes-per-file */
// eslint-disable-next-line
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
// eslint-disable-next-line
/* eslint-disable class-methods-use-this */
// eslint-disable-next-line
/* eslint-disable consistent-return */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { CancellationToken, Disposable, Event, EventEmitter, Uri } from 'vscode';
import { IApplicationEnvironment, IApplicationShell } from '../common/application/types';
import { InterpreterUri } from '../common/installer/types';
import { IExtensions, InstallerResponse, IPersistentStateFactory, Product, Resource } from '../common/types';
import { createDeferred } from '../common/utils/async';
import * as localize from '../common/utils/localize';
import { noop } from '../common/utils/misc';
import { PythonExtension } from '../datascience/constants';
import { IEnvironmentActivationService } from '../interpreter/activation/types';
import { IInterpreterQuickPickItem, IInterpreterSelector } from '../interpreter/configuration/types';
import { IInterpreterService } from '../interpreter/contracts';
import { IWindowsStoreInterpreter } from '../interpreter/locators/types';
import { PythonEnvironment } from '../pythonEnvironments/info';
import {
    ILanguageServer,
    ILanguageServerProvider,
    IPythonApiProvider,
    IPythonDebuggerPathProvider,
    IPythonExtensionChecker,
    IPythonInstaller,
    JupyterProductToInstall,
    PythonApi
} from './types';

/* eslint-disable max-classes-per-file */
@injectable()
export class PythonApiProvider implements IPythonApiProvider {
    private readonly api = createDeferred<PythonApi>();

    private initialized?: boolean;

    constructor(
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IPythonExtensionChecker) private extensionChecker: IPythonExtensionChecker
    ) {}

    public getApi(): Promise<PythonApi> {
        this.init().catch(noop);
        return this.api.promise;
    }

    public setApi(api: PythonApi): void {
        if (this.api.resolved) {
            return;
        }
        this.api.resolve(api);
    }

    private async init() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        const pythonExtension = this.extensions.getExtension<{ jupyter: { registerHooks(): void } }>(PythonExtension);
        if (!pythonExtension) {
            await this.extensionChecker.showPythonExtensionInstallRequiredPrompt();
        } else {
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            pythonExtension.exports.jupyter.registerHooks();
        }
    }
}

@injectable()
export class PythonExtensionChecker implements IPythonExtensionChecker {
    private extensionChangeHandler: Disposable | undefined;
    private pythonExtensionId = PythonExtension;
    private waitingOnInstallPrompt?: Promise<void>;
    constructor(
        @inject(IExtensions) private readonly extensions: IExtensions,
        @inject(IPersistentStateFactory) private readonly persistentStateFactory: IPersistentStateFactory,
        @inject(IApplicationShell) private readonly appShell: IApplicationShell,
        @inject(IApplicationEnvironment) private readonly appEnv: IApplicationEnvironment
    ) {
        // If the python extension is not installed listen to see if anything does install it
        if (!this.isPythonExtensionInstalled) {
            this.extensionChangeHandler = this.extensions.onDidChange(this.extensionsChangeHandler.bind(this));
        }
    }

    public get isPythonExtensionInstalled() {
        return this.extensions.getExtension(this.pythonExtensionId) !== undefined;
    }

    public async showPythonExtensionInstallRequiredPrompt(): Promise<void> {
        if (this.waitingOnInstallPrompt) {
            return this.waitingOnInstallPrompt;
        }
        // Ask user if they want to install and then wait for them to actually install it.
        const yes = localize.Common.bannerLabelYes();
        const no = localize.Common.bannerLabelNo();
        const answer = await this.appShell.showErrorMessage(localize.DataScience.pythonExtensionRequired(), yes, no);
        if (answer === yes) {
            await this.installPythonExtension();
        }
    }

    public async showPythonExtensionInstallRecommendedPrompt() {
        const key = 'ShouldShowPythonExtensionInstallRecommendedPrompt';
        const surveyPrompt = this.persistentStateFactory.createGlobalPersistentState(key, true);
        if (surveyPrompt.value) {
            const yes = localize.Common.bannerLabelYes();
            const no = localize.Common.bannerLabelNo();
            const doNotShowAgain = localize.Common.doNotShowAgain();

            const promise = (this.waitingOnInstallPrompt = new Promise<void>(async (resolve) => {
                const answer = await this.appShell.showInformationMessage(
                    localize.DataScience.pythonExtensionRecommended(),
                    yes,
                    no,
                    doNotShowAgain
                );
                switch (answer) {
                    case yes:
                        await this.installPythonExtension();
                        break;
                    case doNotShowAgain:
                        await surveyPrompt.updateValue(false);
                        break;
                    default:
                        break;
                }
                resolve();
            }));
            await promise;
            this.waitingOnInstallPrompt = undefined;
        }
    }

    private async installPythonExtension() {
        // Have the user install python
        this.appShell.openUrl(`${this.appEnv.uriScheme}:extension/${this.pythonExtensionId}`);
    }

    private async extensionsChangeHandler(): Promise<void> {
        // On extension change see if python was installed, if so unhook our extension change watcher and
        // notify the user that they might need to restart notebooks or interactive windows
        if (this.isPythonExtensionInstalled && this.extensionChangeHandler) {
            this.extensionChangeHandler.dispose();
            this.extensionChangeHandler = undefined;

            this.appShell
                .showInformationMessage(localize.DataScience.pythonExtensionInstalled(), localize.Common.ok())
                .then(noop, noop);
        }
    }
}

@injectable()
export class LanguageServerProvider implements ILanguageServerProvider {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public getLanguageServer(resource?: InterpreterUri): Promise<ILanguageServer | undefined> {
        return this.apiProvider.getApi().then((api) => api.getLanguageServer(resource));
    }
}

@injectable()
export class WindowsStoreInterpreter implements IWindowsStoreInterpreter {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public isWindowsStoreInterpreter(pythonPath: string): Promise<boolean> {
        return this.apiProvider.getApi().then((api) => api.isWindowsStoreInterpreter(pythonPath));
    }
}

@injectable()
export class PythonDebuggerPathProvider implements IPythonDebuggerPathProvider {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public getDebuggerPath(): Promise<string> {
        return this.apiProvider.getApi().then((api) => api.getDebuggerPath());
    }
}

const ProductMapping: { [key in Product]: JupyterProductToInstall } = {
    [Product.ipykernel]: JupyterProductToInstall.ipykernel,
    [Product.jupyter]: JupyterProductToInstall.jupyter,
    [Product.kernelspec]: JupyterProductToInstall.kernelspec,
    [Product.nbconvert]: JupyterProductToInstall.nbconvert,
    [Product.notebook]: JupyterProductToInstall.notebook,
    [Product.pandas]: JupyterProductToInstall.pandas
};

/* eslint-disable max-classes-per-file */
@injectable()
export class PythonInstaller implements IPythonInstaller {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public install(
        product: Product,
        resource?: InterpreterUri,
        cancel?: CancellationToken
    ): Promise<InstallerResponse> {
        return this.apiProvider.getApi().then((api) => api.install(ProductMapping[product], resource, cancel));
    }
}

// eslint-disable-next-line max-classes-per-file
@injectable()
export class EnvironmentActivationService implements IEnvironmentActivationService {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public async getActivatedEnvironmentVariables(
        resource: Resource,
        interpreter?: PythonEnvironment
    ): Promise<NodeJS.ProcessEnv | undefined> {
        return this.apiProvider
            .getApi()
            .then((api) => api.getActivatedEnvironmentVariables(resource, interpreter, true));
    }
}

// eslint-disable-next-line max-classes-per-file
@injectable()
export class InterpreterSelector implements IInterpreterSelector {
    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public async getSuggestions(resource: Resource): Promise<IInterpreterQuickPickItem[]> {
        return this.apiProvider.getApi().then((api) => api.getSuggestions(resource));
    }
}
// eslint-disable-next-line max-classes-per-file
@injectable()
export class InterpreterService implements IInterpreterService {
    private readonly didChangeInterpreter = new EventEmitter<void>();

    constructor(@inject(IPythonApiProvider) private readonly apiProvider: IPythonApiProvider) {}

    public get onDidChangeInterpreter(): Event<void> {
        return this.didChangeInterpreter.event;
    }

    public getInterpreters(resource?: Uri): Promise<PythonEnvironment[]> {
        return this.apiProvider.getApi().then((api) => api.getInterpreters(resource));
    }

    public getActiveInterpreter(resource?: Uri): Promise<PythonEnvironment | undefined> {
        return this.apiProvider.getApi().then((api) => api.getActiveInterpreter(resource));
    }

    public getInterpreterDetails(pythonPath: string, resource?: Uri): Promise<undefined | PythonEnvironment> {
        return this.apiProvider.getApi().then((api) => api.getInterpreterDetails(pythonPath, resource));
    }
}
