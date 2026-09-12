package com.flockradar.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Relaunches the app after the device boots, so recording / alerts can resume
 * when "Start recording automatically when the app opens" is enabled.
 *
 * Note: Android 10+ restricts starting an Activity from the background. On many
 * OEM builds (Xiaomi, Samsung, Oppo, ...) this only works if the user has
 * allowed "Autostart" and/or removed the app from battery optimization. See
 * NATIVE.md for the per-device steps.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }
        final String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(launch);
                } catch (Exception e) {
                    // Background activity-start blocked by the OS/OEM policy.
                    // The user must enable autostart for the app.
                }
            }
        }
    }
}
