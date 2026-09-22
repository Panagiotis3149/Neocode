package wtf.pana.neocode.jetbrains.notifications

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

/**
 * Notification orchestration for the Neocode plugin.
 *
 * Wraps IntelliJ's [com.intellij.notification.NotificationGroup] to surface
 * connection lifecycle events, errors, and user-facing prompts (e.g.
 * "Neocode connected", "Diff rejected", "Add-to-context payload too large").
 *
 * The "Neocode" notification group is declared in `plugin.xml` as a sticky balloon;
 * the group id is the lookup key here.
 */
object NotificationManager {
    private const val GROUP_ID = "Neocode"

    /**
     * Show an informational balloon notification.
     */
    fun notifyInfo(project: Project?, title: String, content: String) {
        notify(project, title, content, NotificationType.INFORMATION)
    }

    /**
     * Show an error balloon notification.
     */
    fun notifyError(project: Project?, title: String, content: String) {
        notify(project, title, content, NotificationType.ERROR)
    }

    /**
     * Show a warning balloon notification.
     */
    fun notifyWarning(project: Project?, title: String, content: String) {
        notify(project, title, content, NotificationType.WARNING)
    }

    private fun notify(project: Project?, title: String, content: String, type: NotificationType) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup(GROUP_ID)
        // NotificationGroup is non-null when the group is registered in plugin.xml;
        // if the registration is missing we swallow rather than throw — the IDE still
        // works, the user just doesn't see the message.
        group?.createNotification(title, content, type)?.notify(project)
    }
}
