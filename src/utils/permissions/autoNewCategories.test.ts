import { describe, expect, it } from 'bun:test'
import { classifyAutoNewCategory } from './autoNewCategories.js'

describe('classifyAutoNewCategory', () => {
  it('classifies permanent deletes as shiftDelete', () => {
    expect(classifyAutoNewCategory('rm -rf dist', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('rm -r -f dist', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('rmdir /s build', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('del /f file.txt', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('remove-item -force x', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('git clean -fd', '/repo')).toBe('shiftDelete')
    expect(classifyAutoNewCategory('git reset --hard HEAD~1', '/repo')).toBe(
      'shiftDelete',
    )
  })

  it('classifies soft deletes as recycleBin', () => {
    expect(classifyAutoNewCategory('trash old.txt', '/repo')).toBe('recycleBin')
    expect(classifyAutoNewCategory('rm old.txt', '/repo')).toBe('recycleBin')
    expect(classifyAutoNewCategory('del old.txt', '/repo')).toBe('recycleBin')
    expect(classifyAutoNewCategory('rd build', '/repo')).toBe('recycleBin')
    expect(classifyAutoNewCategory('rmdir build', '/repo')).toBe('recycleBin')
    expect(classifyAutoNewCategory('remove-item x', '/repo')).toBe('recycleBin')
  })

  it('classifies temp path reads/writes', () => {
    expect(classifyAutoNewCategory('cat temp/log.txt', '/repo')).toBe('tempRead')
    expect(classifyAutoNewCategory('ls temp/', '/repo')).toBe('tempRead')
    expect(classifyAutoNewCategory('echo hi > temp/out.txt', '/repo')).toBe(
      'tempWrite',
    )
    expect(classifyAutoNewCategory('cp a.txt temp/', '/repo')).toBe('tempWrite')
  })

  it('classifies system read (process listing) as systemRead', () => {
    expect(classifyAutoNewCategory('tasklist', '/repo')).toBe('systemRead')
    expect(classifyAutoNewCategory('ps aux', '/repo')).toBe('systemRead')
    expect(classifyAutoNewCategory('Get-Process', '/repo')).toBe('systemRead')
  })

  it('classifies system write (stopping/restarting) as systemWrite', () => {
    expect(classifyAutoNewCategory('kill 1234', '/repo')).toBe('systemWrite')
    expect(classifyAutoNewCategory('taskkill /PID 1234', '/repo')).toBe(
      'systemWrite',
    )
    expect(classifyAutoNewCategory('shutdown /r', '/repo')).toBe('systemWrite')
    expect(classifyAutoNewCategory('systemctl restart nginx', '/repo')).toBe(
      'systemWrite',
    )
  })

  it('classifies online reads as onlineRead', () => {
    expect(classifyAutoNewCategory('git fetch', '/repo')).toBe('onlineRead')
    expect(classifyAutoNewCategory('git clone https://x', '/repo')).toBe(
      'onlineRead',
    )
    expect(classifyAutoNewCategory('curl https://example.com', '/repo')).toBe(
      'onlineRead',
    )
    expect(classifyAutoNewCategory('gh api repos/foo/bar', '/repo')).toBe(
      'onlineRead',
    )
    expect(classifyAutoNewCategory('gh pr list', '/repo')).toBe('onlineRead')
  })

  it('classifies online writes as onlineWrite', () => {
    expect(classifyAutoNewCategory('git push', '/repo')).toBe('onlineWrite')
    expect(classifyAutoNewCategory('curl -X POST https://x', '/repo')).toBe(
      'onlineWrite',
    )
    expect(classifyAutoNewCategory('curl -d "a=b" https://x', '/repo')).toBe(
      'onlineWrite',
    )
    expect(classifyAutoNewCategory('gh api graphql -X POST', '/repo')).toBe(
      'onlineWrite',
    )
    expect(classifyAutoNewCategory('npm publish', '/repo')).toBe('onlineWrite')
    expect(classifyAutoNewCategory('scp file remote:path', '/repo')).toBe(
      'onlineWrite',
    )
  })

  it('falls through to other', () => {
    expect(classifyAutoNewCategory('echo hello', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('', '/repo')).toBe('other')
  })

  it('treats vulnerable UNC paths as onlineWrite', () => {
    expect(
      classifyAutoNewCategory('type \\\\evil\\share\\file.txt', '/repo'),
    ).toBe('onlineWrite')
  })

  it('classifies safe dev tooling as safeDev', () => {
    // Build systems / compilers
    expect(classifyAutoNewCategory('gradle build', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('mvn test', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('make', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('cmake --build .', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('dotnet build', '/repo')).toBe('safeDev')
    // Test runners
    expect(classifyAutoNewCategory('npm run test', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('yarn test', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('pnpm run lint', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('bun run build', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('jest', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('vitest', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('pytest', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('go test ./...', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('cargo build', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('tsc', '/repo')).toBe('safeDev')
    // Archive / container inspection (read-only)
    expect(classifyAutoNewCategory('jar tf foo.jar', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('unzip -l foo.zip', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('tar tf foo.tar', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('zipinfo foo.zip', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('docker inspect img', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('rpm -qlp foo.rpm', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('dpkg -c foo.deb', '/repo')).toBe('safeDev')
    // Decompilers / bytecode & binary viewers (read-only)
    expect(classifyAutoNewCategory('javap SomeClass', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('jadx app.apk', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('procyon Foo.jar', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('objdump -d a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('readelf -h a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('strings a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('nm a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('gdb -batch a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('xxd a.out', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('file a.out', '/repo')).toBe('safeDev')
    // Package / dependency info (read-only)
    expect(classifyAutoNewCategory('npm ls', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('npm view react', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('pip show requests', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('pip list', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('cargo tree', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('go list ./...', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('mvn dependency:tree', '/repo')).toBe('safeDev')
    expect(classifyAutoNewCategory('brew info git', '/repo')).toBe('safeDev')
  })

  it('does NOT classify dangerous siblings as safeDev', () => {
    // destructive compound with rm should stay shiftDelete, not safeDev
    expect(classifyAutoNewCategory('npm run clean && rm -rf dist', '/repo')).toBe(
      'shiftDelete',
    )
    // network push stays onlineWrite
    expect(classifyAutoNewCategory('docker push img:latest', '/repo')).toBe(
      'onlineWrite',
    )
    // npm publish stays onlineWrite (publish excluded from safeDev)
    expect(classifyAutoNewCategory('npm publish', '/repo')).toBe('onlineWrite')
    // yarn publish stays onlineWrite
    expect(classifyAutoNewCategory('yarn publish', '/repo')).toBe('onlineWrite')
  })

  describe('script vs executable', () => {
    it('classifies script-interpreter launches as runScript', () => {
      expect(classifyAutoNewCategory('python x.py', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('python3 x.py', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('bash build.sh', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('sh -c "echo hi"', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('ruby script.rb', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('perl x.pl', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('php script.php', '/repo')).toBe('runScript')
      expect(classifyAutoNewCategory('pwsh setup.ps1', '/repo')).toBe('runScript')
    })

    it('keeps build runners as safeDev (not runScript)', () => {
      // node/bun/deno are build runners, not script interpreters here
      expect(classifyAutoNewCategory('node server.js', '/repo')).toBe('safeDev')
      expect(classifyAutoNewCategory('bun run dev', '/repo')).toBe('safeDev')
      expect(classifyAutoNewCategory('deno run x.ts', '/repo')).toBe('safeDev')
    })

    it('classifies direct binary invocation as runExecutable', () => {
      expect(classifyAutoNewCategory('./dist/app', '/repo')).toBe('runExecutable')
      expect(classifyAutoNewCategory('../bin/tool', '/repo')).toBe('runExecutable')
      expect(classifyAutoNewCategory('/usr/local/bin/app', '/repo')).toBe(
        'runExecutable',
      )
    })

    it('allowlist scriptCommands forces runScript', () => {
      const opts = { scriptCommands: ['build.sh'] }
      expect(
        classifyAutoNewCategory('bash build.sh', '/repo', opts),
      ).toBe('runScript')
      expect(classifyAutoNewCategory('./build.sh', '/repo', opts)).toBe('runScript')
    })

    it('allowlist executables forces runExecutable', () => {
      const opts = { executables: ['tool'] }
      expect(classifyAutoNewCategory('./tool', '/repo', opts)).toBe('runExecutable')
      expect(classifyAutoNewCategory('/usr/bin/tool', '/repo', opts)).toBe(
        'runExecutable',
      )
    })
  })
})
