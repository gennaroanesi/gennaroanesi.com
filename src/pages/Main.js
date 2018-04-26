import React from 'react';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import styled from 'styled-components';
import Typography from 'material-ui/Typography';
import { withStyles } from 'material-ui/styles';
import Typist from 'react-typist';

import AppLayout from '../layout/App';
import ContentLayout from '../layout/Content';
import Header from '../presentational/Header';
import Footer from '../presentational/Footer';

const Wrapper = styled.div`
   {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
`;

const styles = {
  title: {
    color: 'rgba(255,255,255,0.9)',
  },
  secondaryText: {
    color: 'rgba(220,220,220,0.9)',
  },
};

const Main = ({ classes }) => (
  <AppLayout>
    <Header />
    <ContentLayout>
      <Wrapper>
        <Typography
          className={classNames(classes.title)}
          variant="display3"
          align="center"
          gutterBottom
        >
          Gennaro Anesi
        </Typography>
        <Typography
          className={classNames(classes.secondaryText)}
          variant="title"
          align="center"
          gutterBottom
        >
          <Typist
            avgTypingDelay={50}
            startDelay={500}
            cursor={{
              hideWhenDone: true,
              hideWhenDoneDelay: 200,
            }}
          >
            Making businesses smarter
          </Typist>
        </Typography>
      </Wrapper>
    </ContentLayout>
    <Footer />
  </AppLayout>
);

Main.propTypes = {
  classes: PropTypes.object.isRequired,
};

export default withStyles(styles)(Main);
