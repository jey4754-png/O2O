import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Calculator as CalculatorIcon, Minus, Package, Plus, Users } from 'lucide-react';
import { track, useScreenAnalytics } from './analytics';
import {
  calculateProductAllocation,
  calculateSplit,
  MAX_GROUP_PARTICIPANTS,
  MAX_PRODUCT_QUANTITY,
} from './trade';

function formatWon(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

export default function SplitCalculator({
  initialTotal = 39000,
  initialPeople = 3,
  initialProductQuantity = 3,
  initialSelectedQuantity = 1,
  onBack,
  onCreateGroup,
}) {
  useScreenAnalytics('split_calculator');
  const normalizedProductQuantity = Math.min(
    MAX_PRODUCT_QUANTITY,
    Math.max(1, Math.floor(Number(initialProductQuantity || initialPeople || 3))),
  );
  const [total, setTotal] = useState(String(Math.max(0, Number(initialTotal || 39000))));
  const [people, setPeople] = useState(Math.min(MAX_GROUP_PARTICIPANTS, Math.max(1, Math.floor(Number(initialPeople || 3)))));
  const [productQuantity, setProductQuantity] = useState(normalizedProductQuantity);
  const [selectedQuantity, setSelectedQuantity] = useState(
    Math.min(
      normalizedProductQuantity,
      Math.max(1, Math.floor(Number(initialSelectedQuantity || 1))),
    ),
  );
  const numericTotal = Math.max(0, Math.floor(Number(total || 0)));
  const result = useMemo(() => calculateSplit(numericTotal, people, 1), [numericTotal, people]);
  const productResult = useMemo(
    () => calculateProductAllocation(numericTotal, productQuantity, selectedQuantity),
    [numericTotal, productQuantity, selectedQuantity],
  );

  useEffect(() => {
    track('calculator_opened', { total: numericTotal, people });
  }, []);

  useEffect(() => {
    track('calculator_result_viewed', {
      total: numericTotal,
      people,
      expected_per_person: result.perPerson,
      remaining_people: result.remaining,
      approximate: result.approximate,
      product_quantity: productResult.productQuantity,
      selected_quantity: productResult.selectedQuantity,
      unit_price: productResult.unitPrice,
      remaining_product_quantity: productResult.remainingQuantity,
    });
  }, [
    numericTotal,
    people,
    result.perPerson,
    result.remaining,
    result.approximate,
    productResult.productQuantity,
    productResult.remainingQuantity,
    productResult.selectedQuantity,
    productResult.unitPrice,
  ]);

  const changePeople = (delta) => {
    setPeople((current) => {
      const next = Math.min(MAX_GROUP_PARTICIPANTS, Math.max(1, current + delta));
      if (next !== current) {
        track('calculator_people_changed', {
          from_people: current,
          to_people: next,
          total: numericTotal,
        });
      }
      return next;
    });
  };

  const changeProductQuantity = (delta) => {
    setProductQuantity((current) => {
      const next = Math.min(MAX_PRODUCT_QUANTITY, Math.max(1, current + delta));
      setSelectedQuantity((selected) => Math.min(selected, next));
      if (next !== current) {
        track('calculator_product_quantity_changed', {
          from_quantity: current,
          to_quantity: next,
          total: numericTotal,
        });
      }
      return next;
    });
  };

  const changeSelectedQuantity = (delta) => {
    setSelectedQuantity((current) => {
      const next = Math.min(productQuantity, Math.max(1, current + delta));
      if (next !== current) {
        track('calculator_selected_quantity_changed', {
          from_quantity: current,
          to_quantity: next,
          product_quantity: productQuantity,
        });
      }
      return next;
    });
  };

  return (
    <section className="screen calculator-screen">
      <header className="top-nav compact">
        <button className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft size={22} />
        </button>
        <h1>예상 부담금 계산기</h1>
        <CalculatorIcon size={20} />
      </header>

      <div className="calculator-hero">
        <CalculatorIcon size={28} />
        <div>
          <strong>그룹 참여 전에도 자유롭게 계산해 보세요</strong>
          <p>여기서 바꾼 인원은 기존 그룹의 실제 목표 인원에 영향을 주지 않습니다.</p>
        </div>
      </div>

      <div className="form-stack calculator-form">
        <label>
          상품 판매가
          <div className="money-input">
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={total}
              onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))}
            />
            <span>원</span>
          </div>
        </label>
        <div className="calculator-people-row">
          <div>
            <span>총 분할 인원</span>
            <small>최대 {MAX_GROUP_PARTICIPANTS}명</small>
          </div>
          <div className="counter" aria-label={`총 분할 인원 ${people}명`}>
            <button type="button" onClick={() => changePeople(-1)} disabled={people <= 1} aria-label="인원 감소">
              <Minus size={16} />
            </button>
            <strong>{people}명</strong>
            <button type="button" onClick={() => changePeople(1)} disabled={people >= MAX_GROUP_PARTICIPANTS} aria-label="인원 증가">
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="calculator-people-row">
          <div>
            <span>상품 총수량</span>
            <small>한 묶음에 들어 있는 제품 수</small>
          </div>
          <div className="counter" aria-label={`상품 총수량 ${productQuantity}개`}>
            <button type="button" onClick={() => changeProductQuantity(-1)} disabled={productQuantity <= 1} aria-label="상품 수량 감소">
              <Minus size={16} />
            </button>
            <strong>{productQuantity}개</strong>
            <button type="button" onClick={() => changeProductQuantity(1)} disabled={productQuantity >= MAX_PRODUCT_QUANTITY} aria-label="상품 수량 증가">
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="calculator-people-row">
          <div>
            <span>내가 가져갈 수량</span>
            <small>선택 수량에 따라 부담금 자동 계산</small>
          </div>
          <div className="counter" aria-label={`내가 가져갈 수량 ${selectedQuantity}개`}>
            <button type="button" onClick={() => changeSelectedQuantity(-1)} disabled={selectedQuantity <= 1} aria-label="선택 수량 감소">
              <Minus size={16} />
            </button>
            <strong>{selectedQuantity}개</strong>
            <button type="button" onClick={() => changeSelectedQuantity(1)} disabled={selectedQuantity >= productQuantity} aria-label="선택 수량 증가">
              <Plus size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="split-result-card" aria-live="polite">
        <span>{selectedQuantity}개 선택 시 예상 부담금</span>
        <strong>{productResult.approximate ? '약 ' : ''}{formatWon(productResult.selectedAmount)}</strong>
        {productResult.approximate && (
          <p>호스트가 선택하면 나머지 {formatWon(productResult.remainder)}을 포함해 약 {formatWon(productResult.hostSelectedAmount)}입니다.</p>
        )}
      </div>

      <div className="allocation-status-grid" aria-live="polite">
        <div>
          <Users size={18} />
          <span>현재 / 목표 인원</span>
          <strong>1명 / {people}명</strong>
          <small>추가 모집 {result.remaining}명</small>
        </div>
        <div>
          <Package size={18} />
          <span>남은 제품 수량</span>
          <strong>{productResult.remainingQuantity}개</strong>
          <small>총 {productQuantity}개 중 {selectedQuantity}개 선택</small>
        </div>
      </div>

      <div className="calculator-comparison">
        <div>
          <span>혼자 전체 구매 시</span>
          <del>{formatWon(result.total)}</del>
        </div>
        <div>
          <span>제품 1개당 예상금액</span>
          <strong>{productResult.approximate ? '약 ' : ''}{formatWon(productResult.unitPrice)}</strong>
        </div>
        <div>
          <span>선택 {selectedQuantity}개 예상금액</span>
          <strong>{productResult.approximate ? '약 ' : ''}{formatWon(productResult.selectedAmount)}</strong>
        </div>
        <div>
          <span>인원 균등 분할 참고값</span>
          <strong>{result.approximate ? '약 ' : ''}{formatWon(result.perPerson)}</strong>
        </div>
        <div>
          <span>혼자 전체 구매 대비</span>
          <strong>{formatWon(Math.max(0, result.total - productResult.selectedAmount))} 감소</strong>
        </div>
      </div>

      <p className="calculator-notice">
        개당 금액은 총액을 상품 수량으로 나누어 원 단위 내림합니다. 남는 {formatWon(productResult.remainder)}은 호스트가 부담해 전체 합계를 맞춥니다.
      </p>

      <div className="sticky-actions single">
        <button
          className="primary-button"
          disabled={numericTotal <= 0}
          onClick={() => onCreateGroup({
            total: result.total,
            people: result.people,
            expectedPerPerson: result.perPerson,
            hostExpectedAmount: result.hostAmount,
            approximate: result.approximate,
            totalQuantity: productResult.productQuantity,
            creatorQuantity: productResult.selectedQuantity,
            productQuantity: productResult.productQuantity,
            creatorProductQuantity: productResult.selectedQuantity,
            unitPrice: productResult.unitPrice,
            creatorExpectedAmount: productResult.selectedAmount,
            hostCreatorExpectedAmount: productResult.hostSelectedAmount,
            productRemainder: productResult.remainder,
          })}
        >
          <Users size={18} />
          이 조건으로 그룹 만들기
        </button>
      </div>
    </section>
  );
}
