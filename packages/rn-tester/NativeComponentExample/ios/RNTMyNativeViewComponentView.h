/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <UIKit/UIKit.h>
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNTMyNativeViewComponentView : RCTViewComponentView

- (UIColor *)UIColorFromHexString: (const std::string)hexString;

@end

NS_ASSUME_NONNULL_END
