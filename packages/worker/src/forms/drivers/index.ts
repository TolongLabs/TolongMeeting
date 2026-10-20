import type { FormProvider } from '@tm/core'
import { createDriver, type FormDriver } from './driver'
import { loadFormSelectors } from './selectors'

export {
  createDriver,
  FormStepError,
  NEXT_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  type DriverTimeouts,
  type FormDriver,
  type FormStepCode
} from './driver'
export { FormSelectorsSchema, loadFormSelectors, type FormSelectors } from './selectors'

const drivers = new Map<FormProvider, Promise<FormDriver>>()

// Loads the provider's selector map once and keeps the driver. A map that fails to load is not cached.
export function driverFor(provider: FormProvider): Promise<FormDriver> {
  let driver = drivers.get(provider)
  if (driver === undefined) {
    driver = loadFormSelectors(provider).then((map) => createDriver(provider, map))
    drivers.set(provider, driver)
    driver.catch(() => drivers.delete(provider))
  }
  return driver
}
