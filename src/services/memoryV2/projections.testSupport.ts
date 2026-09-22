import { ProjectionManager, type ProjectionManagerOptions } from './projections.js'
import {
  createVerifiedProjectionFilesystem,
  projectionFilesystemOption,
  type ProjectionFilesystemAdapter,
} from './projectionFilesystemCapability.js'

export type { ProjectionFilesystemAdapter, ProjectionLeaseFence } from './projectionFilesystemCapability.js'

export function createProjectionTestManager(options: ProjectionManagerOptions, adapter: ProjectionFilesystemAdapter): ProjectionManager {
  const internalOptions = {
    ...options,
    [projectionFilesystemOption]: createVerifiedProjectionFilesystem(adapter),
  }
  return new ProjectionManager(internalOptions as unknown as ProjectionManagerOptions)
}
