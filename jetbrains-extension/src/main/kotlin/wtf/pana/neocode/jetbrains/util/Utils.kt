package wtf.pana.neocode.jetbrains.util

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Misc helpers shared across tool handlers.
 */
object Utils {
    /**
     * Resolve the last-focused opened project, or `null` if no projects are open.
     */
    fun getLastFocusedOpenedProject(): Project? {
        val open = ProjectManager.getInstance().openProjects
        return open.firstOrNull()
    }

    /**
     * Resolve an absolute (or project-relative) path to a [VirtualFile].
     * Returns `null` if the file does not exist on disk.
     */
    fun openVirtualFileFromPath(path: String, projectDir: Path): VirtualFile? {
        val abs = Paths.get(path)
        LocalFileSystem.getInstance().findFileByIoFile(abs.toFile())?.let { return it }

        val rel = projectDir.resolve(path)
        return LocalFileSystem.getInstance().findFileByIoFile(rel.toFile())
    }

    /**
     * Project base directory as a [Path], or null if the project has no base path.
     */
    fun getProjectDir(project: Project): Path? =
        project.basePath?.let { Paths.get(it) }
}
