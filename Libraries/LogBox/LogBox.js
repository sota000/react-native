/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

import Platform from '../Utilities/Platform';
import RCTLog from '../Utilities/RCTLog';

import type {IgnorePattern, LogData} from './Data/LogBoxData';
import type {ExtendedExceptionData} from './Data/parseLogBoxLog';

export type {LogData, ExtendedExceptionData, IgnorePattern};

let LogBox;

interface ILogBox {
  install(): void;
  uninstall(): void;
  isInstalled(): boolean;
  ignoreLogs($ReadOnlyArray<IgnorePattern>): void;
  ignoreAllLogs(?boolean): void;
  clearAllLogs(): void;
  addLog(log: LogData): void;
  addException(error: ExtendedExceptionData): void;
}

/**
 * LogBox displays logs in the app.
 */
if (__DEV__) {
  const LogBoxData = require('./Data/LogBoxData');
  const {parseLogBoxLog, parseInterpolation} = require('./Data/parseLogBoxLog');

  let originalConsoleError;
  let originalConsoleWarn;
  let consoleErrorImpl;
  let consoleWarnImpl;

  let isLogBoxInstalled: boolean = false;

  LogBox = {
    install(): void {
      if (isLogBoxInstalled) {
        return;
      }

      isLogBoxInstalled = true;

      // Trigger lazy initialization of module.
      require('../NativeModules/specs/NativeLogBox');

      // IMPORTANT: we only overwrite `console.error` and `console.warn` once.
      // When we uninstall we keep the same reference and only change its
      // internal implementation
      const isFirstInstall = originalConsoleError == null;
      if (isFirstInstall) {
        originalConsoleError = console.error.bind(console);
        originalConsoleWarn = console.warn.bind(console);

        // $FlowExpectedError[cannot-write]
        console.error = (...args) => {
          consoleErrorImpl(...args);
        };
        // $FlowExpectedError[cannot-write]
        console.warn = (...args) => {
          consoleWarnImpl(...args);
        };
      }

      consoleErrorImpl = registerError;
      consoleWarnImpl = registerWarning;

      if ((console: any).disableYellowBox === true) {
        LogBoxData.setDisabled(true);
        console.warn(
          'console.disableYellowBox has been deprecated and will be removed in a future release. Please use LogBox.ignoreAllLogs(value) instead.',
        );
      }

      (Object.defineProperty: any)(console, 'disableYellowBox', {
        configurable: true,
        get: () => LogBoxData.isDisabled(),
        set: value => {
          LogBoxData.setDisabled(value);
          console.warn(
            'console.disableYellowBox has been deprecated and will be removed in a future release. Please use LogBox.ignoreAllLogs(value) instead.',
          );
        },
      });

      if (Platform.isTesting) {
        LogBoxData.setDisabled(true);
      }

      RCTLog.setWarningHandler((...args) => {
        registerWarning(...args);
      });
    },

    uninstall(): void {
      if (!isLogBoxInstalled) {
        return;
      }

      isLogBoxInstalled = false;

      // IMPORTANT: we don't re-assign to `console` in case the method has been
      // decorated again after installing LogBox. E.g.:
      // Before uninstalling: original > LogBox > OtherErrorHandler
      // After uninstalling:  original > LogBox (noop) > OtherErrorHandler
      consoleErrorImpl = originalConsoleError;
      consoleWarnImpl = originalConsoleWarn;
      delete (console: any).disableLogBox;
    },

    isInstalled(): boolean {
      return isLogBoxInstalled;
    },

    ignoreLogs(patterns: $ReadOnlyArray<IgnorePattern>): void {
      LogBoxData.addIgnorePatterns(patterns);
    },

    ignoreAllLogs(value?: ?boolean): void {
      LogBoxData.setDisabled(value == null ? true : value);
    },

    clearAllLogs(): void {
      LogBoxData.clear();
    },

    addLog(log: LogData): void {
      if (isLogBoxInstalled) {
        LogBoxData.addLog(log);
      }
    },

    addException(error: ExtendedExceptionData): void {
      if (isLogBoxInstalled) {
        LogBoxData.addException(error);
      }
    },
  };

  const isRCTLogAdviceWarning = (...args: Array<mixed>) => {
    // RCTLogAdvice is a native logging function designed to show users
    // a message in the console, but not show it to them in Logbox.
    return typeof args[0] === 'string' && args[0].startsWith('(ADVICE)');
  };

  const isWarningModuleWarning = (...args: any) => {
    return typeof args[0] === 'string' && args[0].startsWith('Warning: ');
  };

  const registerWarning = (...args: Array<mixed>): void => {
    // Let warnings within LogBox itself fall through.
    if (LogBoxData.isLogBoxErrorMessage(String(args[0]))) {
      originalConsoleError(...args);
      return;
    }

    try {
      if (!isRCTLogAdviceWarning(...args)) {
        const {category, message, componentStack} = parseLogBoxLog(args);

        if (!LogBoxData.isMessageIgnored(message.content)) {
          // Be sure to pass LogBox warnings through.
          originalConsoleWarn(...args);

          LogBoxData.addLog({
            level: 'warn',
            category,
            message,
            componentStack,
          });
        }
      }
    } catch (err) {
      LogBoxData.reportLogBoxError(err);
    }
  };

  const registerError = (...args): void => {
    // Let errors within LogBox itself fall through.
    if (LogBoxData.isLogBoxErrorMessage(args[0])) {
      originalConsoleError(...args);
      return;
    }

    try {
      if (!isWarningModuleWarning(...args)) {
        // Only show LogBox for the 'warning' module, otherwise pass through.
        // By passing through, this will get picked up by the React console override,
        // potentially adding the component stack. React then passes it back to the
        // React Native ExceptionsManager, which reports it to LogBox as an error.
        //
        // The 'warning' module needs to be handled here because React internally calls
        // `console.error('Warning: ')` with the component stack already included.
        originalConsoleError(...args);
        return;
      }

      const format = args[0].replace('Warning: ', '');
      const filterResult = LogBoxData.checkWarningFilter(format);
      if (filterResult.suppressCompletely) {
        return;
      }

      let level = 'error';
      if (filterResult.suppressDialog_LEGACY === true) {
        level = 'warn';
      } else if (filterResult.forceDialogImmediately === true) {
        level = 'fatal'; // Do not downgrade. These are real bugs with same severity as throws.
      }

      // Unfortunately, we need to add the Warning: prefix back for downstream dependencies.
      args[0] = `Warning: ${filterResult.finalFormat}`;
      const {category, message, componentStack} = parseLogBoxLog(args);

      if (!LogBoxData.isMessageIgnored(message.content)) {
        // Interpolate the message so they are formatted for adb and other CLIs.
        // This is different than the message.content above because it includes component stacks.
        const interpolated = parseInterpolation(args);
        originalConsoleError(interpolated.message.content);

        LogBoxData.addLog({
          level,
          category,
          message,
          componentStack,
        });
      }
    } catch (err) {
      LogBoxData.reportLogBoxError(err);
    }
  };
} else {
  LogBox = {
    install(): void {
      // Do nothing.
    },

    uninstall(): void {
      // Do nothing.
    },

    isInstalled(): boolean {
      return false;
    },

    ignoreLogs(patterns: $ReadOnlyArray<IgnorePattern>): void {
      // Do nothing.
    },

    ignoreAllLogs(value?: ?boolean): void {
      // Do nothing.
    },

    clearAllLogs(): void {
      // Do nothing.
    },

    addLog(log: LogData): void {
      // Do nothing.
    },

    addException(error: ExtendedExceptionData): void {
      // Do nothing.
    },
  };
}

module.exports = (LogBox: ILogBox);
