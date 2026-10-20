import type { SigninApi } from '../ui/api'

const { signin } = (window as unknown as { tm: { signin: SigninApi } }).tm
const done = document.getElementById('done')
if (done === null) throw new Error('the page has no #done')

done.addEventListener('click', () => {
  ;(done as HTMLButtonElement).disabled = true
  void signin.done()
})
done.focus()
