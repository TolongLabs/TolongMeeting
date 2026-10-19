import { expect, test } from 'bun:test'
import { correctNames } from '../src/names'

test('names are corrected from authoritative text and marked as heard', () => {
  expect(correctNames('thanks Dr Amina, today Kubernetis and Kubernetes', ['Dr Aminah', 'Kubernetes'])).toBe(
    'thanks Dr Aminah _(as heard: "Dr Amina")_, today Kubernetes _(as heard: "Kubernetis")_ and Kubernetes'
  )
  expect(correctNames('the data is clean', ['Dataset'])).toBe('the data is clean')
})

test('terms shorter than 6 letters are never corrected', () => {
  expect(correctNames('Ali came early', ['Ali'])).toBe('Ali came early')
  expect(correctNames('Ali came early', ['Alice'])).toBe('Ali came early')
})

test('a case-only difference takes the term casing silently, with no note', () => {
  expect(correctNames('today clustering again', ['Clustering'])).toBe('today Clustering again')
})

test('a trailing inflection of a term is left as heard, with no note', () => {
  expect(correctNames('the algorithms work', ['Algorithm'])).toBe('the algorithms work')
  expect(correctNames("the dataset's rows", ['Dataset'])).toBe("the dataset's rows")
})

test('a corrected term is not matched again inside its own note', () => {
  expect(correctNames('Kubernetis', ['Kubernetes'])).toBe('Kubernetes _(as heard: "Kubernetis")_')
})
